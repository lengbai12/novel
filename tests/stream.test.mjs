import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelError, normalizeConfig, streamCompletion} from '../src/model.js';

const config = normalizeConfig({provider: 'openai', api_url: 'https://example.test/v1',
  model: 'mock', reasoning_effort: 'none', api_key: 'synthetic-key'});
const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const content = (text, finish = null) => event({choices: [{delta: {content: text}, finish_reason: finish}]});
const originalFetch = globalThis.fetch;

function setup(t, response) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({url, options});
    return typeof response === 'function' ? response(options) : response;
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return calls;
}

function bytesResponse(text) {
  // 每块仅一个字节，刻意将中文 UTF-8、JSON 和 SSE 分隔符切开。
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  }}));
}

function run(options = {}) {
  return streamCompletion({config, messages: [{role: 'user', content: '合成测试'}],
    maxTokens: 100, temperature: 0.5, thinking: false, schema: null,
    signal: new AbortController().signal, onDelta() {}, ...options});
}

test('正常 SSE 跨字节分块保留中文、思考、用量和结束原因', async t => {
  const calls = setup(t, bytesResponse(': keepalive\r\n' +
    event({choices: [{delta: {reasoning_content: '检查'}}]}) + content('雨停') + content('了。', 'stop') +
    event({choices: [], usage: {prompt_tokens: 12, completion_tokens: 8}}) + 'data: [DONE]\r\n\r\n'));
  const deltas = [];
  assert.deepEqual(await run({onDelta: (...args) => deltas.push(args)}), {
    content: '雨停了。', reasoning: '检查', finishReason: 'stop', promptTokens: 12, completionTokens: 8,
  });
  assert.deepEqual(deltas, [['reasoning', '检查'], ['content', '雨停'], ['content', '了。']]);
  assert.equal(calls[0].url, 'https://example.test/v1/chat/completions');
  assert.equal(JSON.parse(calls[0].options.body).stream, true);
});

test('没有末尾换行的最终事件仍能解析', async t => {
  setup(t, bytesResponse(content('正文', 'stop').trimEnd()));
  assert.equal((await run()).finishReason, 'stop');
});

test('达到 token 上限保留 length，不伪造 stop', async t => {
  setup(t, bytesResponse(content('被截断的片段', 'length') + 'data: [DONE]\n'));
  const result = await run();
  assert.equal(result.finishReason, 'length');
  assert.equal(result.content, '被截断的片段');
});

test('提前 EOF 或只有 DONE 不伪造成功结束原因', async t => {
  for (const text of [content('半句'), content('半句') + 'data: [DONE]\n']) {
    setup(t, bytesResponse(text));
    assert.equal((await run()).finishReason, null);
  }
});

test('HTTP 错误与 SSE 错误均拒绝而非返回成功', async t => {
  setup(t, new Response('rate limited', {status: 429}));
  await assert.rejects(run(), ModelError);
  setup(t, bytesResponse(event({error: {message: 'synthetic failure'}})));
  await assert.rejects(run(), /synthetic failure/);
});

test('损坏 JSON 和读取中断均返回 ModelError', async t => {
  setup(t, bytesResponse('data: {bad json}\n'));
  await assert.rejects(run(), ModelError);
  setup(t, new Response(new ReadableStream({start(controller) {
    controller.error(new Error('synthetic disconnect'));
  }})));
  await assert.rejects(run(), /synthetic disconnect/);
});

test('主动取消中止等待中的读取并保留 AbortError', async t => {
  const abort = new AbortController();
  setup(t, ({signal}) => new Response(new ReadableStream({start(controller) {
    controller.enqueue(new TextEncoder().encode(content('片段')));
    signal.addEventListener('abort', () => controller.error(signal.reason), {once: true});
  }})));
  const deltas = [];
  await assert.rejects(run({signal: abort.signal, onDelta(kind, text) {
    deltas.push([kind, text]);
    abort.abort();
  }}), {name: 'AbortError'});
  assert.deepEqual(deltas, [['content', '片段']]);
});

test('DONE 后主动取消剩余流且不解析尾部垃圾', async t => {
  let cancelled = false;
  setup(t, new Response(new ReadableStream({start(controller) {
    controller.enqueue(new TextEncoder().encode(content('完成', 'stop') + 'data: [DONE]\n' + 'data: {bad}\n'));
  }, cancel() { cancelled = true; }})));
  assert.equal((await run()).content, '完成');
  assert.equal(cancelled, true);
});
