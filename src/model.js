// Browser transport for OpenAI-compatible chat endpoints. Port of novel_model.py.

export class ModelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelError';
  }
}

export const REASONING_BUDGETS = {none: 0, low: 2048, medium: 4096, high: 8192};

// DeepSeek exposes none/low/high/max; medium is folded into high and high into max.
const DEEPSEEK_EFFORT = {none: 'none', low: 'low', medium: 'high', high: 'max'};
const PROVIDER_CONTEXT = {
  llama: 262144,
  siliconflow: 262144,
  deepseek: 1048576,
  openai: 131072,
  generic: 131072,
};
const MODEL_CHECK_TIMEOUT_MS = 10000;
// Idle limit between received chunks, matching the socket timeout of the Python transport.
const STREAM_IDLE_TIMEOUT_MS = 1800000;

// Reproduces Python json.dumps(value, ensure_ascii=False) separators and escaping.
function pyJSON(value) {
  if (Array.isArray(value)) return `[${value.map((item) => pyJSON(item)).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pyJSON(item)}`);
    return `{${entries.join(', ')}}`;
  }
  return JSON.stringify(value);
}

export function normalizeConfig(raw) {
  const {provider, api_url: url, model: modelId, reasoning_effort: effort, api_key: key = ''} = raw;
  if (typeof modelId !== 'string' || !modelId.trim()) {
    throw new Error('请填写模型 ID。');
  }
  if (typeof effort !== 'string' || !Object.hasOwn(REASONING_BUDGETS, effort)) {
    throw new Error('思考强度必须是 none、low、medium 或 high');
  }
  return {
    provider,
    api_url: url.replace(/\/+$/, ''),
    model: modelId.trim(),
    reasoning_effort: effort,
    api_key: key.trim(),
  };
}

function resolveProvider(config) {
  if (['llama', 'siliconflow', 'deepseek', 'openai'].includes(config.provider)) return config.provider;
  const parsed = new URL(config.api_url);
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host === 'api.siliconflow.cn' || host === 'api.siliconflow.com') return 'siliconflow';
  if (host === 'api.deepseek.com' || host.endsWith('.deepseek.com')) return 'deepseek';
  const local = host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  return local && parsed.port === '8000' ? 'llama' : 'generic';
}

export function providerContext(config) {
  return PROVIDER_CONTEXT[resolveProvider(config)];
}

export function identity(config) {
  return pyJSON([config.api_url, config.model, config.reasoning_effort, config.provider]);
}

export function tokenBytes(text) {
  return new TextEncoder().encode(text).length;
}

function requestHeaders(config) {
  const headers = {'Content-Type': 'application/json'};
  if (config.api_key) headers.Authorization = `Bearer ${config.api_key}`;
  return headers;
}

async function responseError(response) {
  const detail = await response.text();
  return new ModelError(`模型 API 返回 ${response.status}：${detail.slice(0, 2000)}`);
}

function completionPayload(config, messages, maxTokens, temperature, schema) {
  const effort = config.reasoning_effort;
  const budget = REASONING_BUDGETS[effort];
  const kind = resolveProvider(config);
  const promptSchema = schema != null && (kind === 'deepseek' || kind === 'openai');
  let chat = messages;
  if (promptSchema) {
    const instruction = 'Return only one JSON object matching this JSON Schema exactly; no prose, code fence or commentary.\n' +
      pyJSON(schema);
    chat = messages[0]?.role === 'system'
      ? [{...messages[0], content: `${messages[0].content}\n\n${instruction}`}, ...messages.slice(1)]
      : [{role: 'system', content: instruction}, ...messages];
  }
  const payload = {
    model: config.model,
    messages: chat,
    stream: true,
    max_tokens: maxTokens + budget,
    temperature: budget ? Math.max(0.6, temperature) : temperature,
    top_p: budget ? 0.9 : 0.85,
    presence_penalty: budget ? 0 : 0.2,
    stream_options: {include_usage: true},
  };
  if (kind === 'siliconflow') {
    payload.enable_thinking = budget > 0;
    payload.top_k = 20;
    if (budget) payload.thinking_budget = budget;
  } else if (kind === 'llama') {
    Object.assign(payload, {
      top_k: 30,
      min_p: 0,
      repeat_penalty: 1.05,
      chat_template_kwargs: {enable_thinking: budget > 0},
      reasoning_budget: budget,
    });
  } else if (kind === 'deepseek') {
    payload.thinking = {type: budget ? 'enabled' : 'disabled'};
    if (budget) {
      payload.reasoning_effort = DEEPSEEK_EFFORT[effort];
      // Thinking mode ignores temperature and penalties; top_p must be 0.95 to 1.0.
      delete payload.temperature;
      delete payload.presence_penalty;
      payload.top_p = 0.95;
    }
  } else if (budget) {
    payload.reasoning_effort = effort;
  }
  if (schema) {
    payload.response_format = promptSchema
      ? {type: 'json_object'}
      : {type: 'json_schema', json_schema: {name: 'review', strict: true, schema}};
  }
  return payload;
}

export async function checkModel(raw) {
  const config = normalizeConfig(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.api_url}/models`, {
      headers: requestHeaders(config),
      signal: controller.signal,
    });
    if (!response.ok) throw await responseError(response);
    const result = await response.json();
    const ready = (result.data || []).some((row) => row.id === config.model);
    return ready ? {ready} : {ready, error: '模型列表中没有该模型 ID。'};
  } catch (error) {
    return {ready: false, error: error instanceof ModelError ? error.message : `无法调用模型 API：${error}`};
  } finally {
    clearTimeout(timer);
  }
}

export async function streamCompletion({config, messages, maxTokens, temperature, thinking, schema, signal, onDelta}) {
  const payload = completionPayload(
    {...config, reasoning_effort: thinking ? config.reasoning_effort : 'none'},
    messages, maxTokens, temperature, schema,
  );
  const idle = new AbortController();
  const armIdle = () => setTimeout(() => idle.abort(), STREAM_IDLE_TIMEOUT_MS);
  let timer = armIdle();
  const contentParts = [];
  const reasoningParts = [];
  let finishReason = null;
  let promptTokens = null;
  let completionTokens = null;

  // Returns true when the stream signals completion.
  const handleLine = (line) => {
    if (!line.startsWith('data:')) return false;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return true;
    const event = JSON.parse(data);
    if (event.error) {
      throw new ModelError(typeof event.error === 'string' ? event.error : JSON.stringify(event.error));
    }
    if (event.usage) {
      promptTokens = event.usage.prompt_tokens ?? null;
      completionTokens = event.usage.completion_tokens ?? null;
    }
    for (const choice of event.choices ?? []) {
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      const reasoning = delta.reasoning_content || delta.reasoning || '';
      if (reasoning) {
        reasoningParts.push(reasoning);
        onDelta('reasoning', reasoning);
      }
      if (delta.content) {
        contentParts.push(delta.content);
        onDelta('content', delta.content);
      }
    }
    return false;
  };

  try {
    const response = await fetch(`${config.api_url}/chat/completions`, {
      method: 'POST',
      headers: requestHeaders(config),
      body: JSON.stringify(payload),
      signal: AbortSignal.any([signal, idle.signal]),
    });
    if (!response.ok) throw await responseError(response);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      clearTimeout(timer);
      timer = armIdle();
      const lines = (buffer + decoder.decode(value, {stream: true})).split('\n');
      buffer = lines.pop();
      if (lines.some((line) => handleLine(line))) {
        finished = true;
        break;
      }
    }
    if (finished) await reader.cancel();
    else handleLine(buffer + decoder.decode());
    return {
      content: contentParts.join('').trim(),
      reasoning: reasoningParts.join(''),
      finishReason,
      promptTokens,
      completionTokens,
    };
  } catch (error) {
    if (signal.aborted || error instanceof ModelError) throw error;
    throw new ModelError(`无法调用模型 API：${error}`);
  } finally {
    clearTimeout(timer);
  }
}
