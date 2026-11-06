"""Persistent private model settings and OpenAI-compatible model transport."""
from __future__ import annotations

import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import urllib.error
import urllib.parse
import urllib.request

DEFAULTS = {"provider": "auto", "api_url": "http://127.0.0.1:8000/v1", "model": "qwen3.5-9b",
            "reasoning_effort": "low", "max_concurrency": 1, "api_key": "", "api_key_provider": ""}
REASONING_BUDGETS = {"none": 0, "low": 2048, "medium": 4096, "high": 8192}
PROVIDERS = ("auto", "llama", "siliconflow", "deepseek", "openai")
# DeepSeek exposes none/low/high/max; medium is folded into high and high into max.
DEEPSEEK_EFFORT = {"none": "none", "low": "low", "medium": "high", "high": "max"}
PROVIDER_CONTEXT = {"llama": 262144, "siliconflow": 262144, "deepseek": 1048576,
                    "openai": 131072, "generic": 131072}

class ModelError(RuntimeError):
    pass


def redact(message, settings):
    text = str(message)
    key = settings.get("api_key", "")
    if key:
        for value in {key, urllib.parse.quote(key, safe=""), json.dumps(key)[1:-1]}:
            text = text.replace(value, "[redacted]")
    return re.sub(r"(?i)bearer\s+[^\s\"'<>]+", "Bearer [redacted]", text)


def validate(values, previous):
    result = dict(previous)
    for field in ("provider", "api_url", "model", "reasoning_effort", "max_concurrency"):
        if field in values:
            result[field] = values[field]
    if result["provider"] not in PROVIDERS:
        raise ValueError("接口类型必须是 auto、llama、siliconflow、deepseek 或 openai")
    url = result["api_url"]
    if not isinstance(url, str) or len(url) > 2048 or any(ch.isspace() for ch in url):
        raise ValueError("API URL 必须是有效的 HTTP(S) 地址")
    parsed = urllib.parse.urlsplit(url)
    try:
        port = parsed.port
    except ValueError:
        raise ValueError("API URL 端口无效") from None
    if (parsed.scheme not in ("http", "https") or not parsed.hostname or
            parsed.username is not None or parsed.password is not None or
            parsed.query or parsed.fragment or port == 0):
        raise ValueError("API URL 必须是无账号、查询参数或片段的 HTTP(S) 基础地址")
    result["api_url"] = url.rstrip("/")
    if not isinstance(result["model"], str) or not result["model"].strip() or len(result["model"]) > 300:
        raise ValueError("模型 ID 必须是 1—300 字符")
    result["model"] = result["model"].strip()
    if not isinstance(result["reasoning_effort"], str) or result["reasoning_effort"] not in REASONING_BUDGETS:
        raise ValueError("思考强度必须是 none、low、medium 或 high")
    concurrency = result["max_concurrency"]
    if isinstance(concurrency, bool) or not isinstance(concurrency, int) or not 1 <= concurrency <= 8:
        raise ValueError("并发数必须介于 1—8")
    if "clear_api_key" in values and not isinstance(values["clear_api_key"], bool):
        raise ValueError("clear_api_key 必须是布尔值")
    if "api_key" in values:
        key = values["api_key"]
        if not isinstance(key, str) or len(key) > 4096 or any(ch in key for ch in "\r\n"):
            raise ValueError("API Key 格式无效")
        if key.strip():
            result["api_key"] = key.strip()
    if values.get("clear_api_key"):
        result["api_key"] = ""
        result["api_key_provider"] = ""
    elif "api_key" in values and isinstance(values["api_key"], str) and values["api_key"].strip():
        result["api_key_provider"] = provider(result)
    elif result["api_key"] and not result.get("api_key_provider"):
        # Legacy single-key configuration: attribute it to the detected interface.
        result["api_key_provider"] = provider(result)
    return result


def load_settings(path):
    settings = dict(DEFAULTS)
    legacy_url = os.environ.get("NOVEL_MODEL_URL")
    if legacy_url:
        settings["api_url"] = legacy_url.rstrip("/")
        if not settings["api_url"].endswith("/v1"):
            settings["api_url"] += "/v1"
    if path.exists():
        os.chmod(path, 0o600)
        try:
            with path.open(encoding="utf-8") as source:
                values = json.load(source)
            if not isinstance(values, dict):
                raise ValueError("配置必须是对象")
            return validate(values, settings)
        except (ValueError, TypeError):
            raise ValueError("模型配置文件无效，请修正 library/model-settings.json") from None
    return validate({}, settings)


def save_settings(path, settings):
    temporary = path.with_name(path.name + "." + secrets.token_hex(8) + ".tmp")
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            json.dump(settings, target, ensure_ascii=False)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def public_settings(settings):
    return {**{key: settings[key] for key in DEFAULTS if key != "api_key"},
            "has_api_key": bool(api_key(settings))}


def identity(settings):
    return json.dumps([settings["api_url"], settings["model"], settings["reasoning_effort"],
                       settings.get("provider", "auto")], ensure_ascii=False)


def provider(settings):
    explicit = settings.get("provider", "auto")
    if explicit in ("llama", "siliconflow", "deepseek", "openai"):
        return explicit
    parsed = urllib.parse.urlsplit(settings["api_url"])
    host = parsed.hostname or ""
    if host in ("api.siliconflow.cn", "api.siliconflow.com"):
        return "siliconflow"
    if host == "api.deepseek.com" or host.endswith(".deepseek.com"):
        return "deepseek"
    try:
        local = ipaddress.ip_address(host).is_loopback
    except ValueError:
        local = host == "localhost"
    return "llama" if local and parsed.port == 8000 else "generic"


def provider_context(settings):
    return PROVIDER_CONTEXT.get(provider(settings), PROVIDER_CONTEXT["generic"])


def api_key(settings):
    """Never send a saved key to a different vendor after switching presets."""
    key = settings.get("api_key", "")
    owner = settings.get("api_key_provider", "")
    if key and owner and owner != provider(settings):
        return ""
    return key


def request(settings, endpoint, payload=None, local=False):
    base = settings["api_url"]
    if local:
        if provider(settings) != "llama":
            raise ModelError("非本地模型不可调用 tokenizer/template 接口")
        base = base.removesuffix("/v1")
    headers = {"Content-Type": "application/json"}
    key = api_key(settings)
    if key:
        headers["Authorization"] = "Bearer " + key
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
    return urllib.request.Request(base + endpoint, body, headers)


def response_error(error, settings):
    if isinstance(error, urllib.error.HTTPError):
        detail = error.read(2000).decode(errors="replace")
        return ModelError(redact(f"模型 API 返回 {error.code}：{detail}", settings))
    return ModelError(redact(f"无法调用模型 API：{error}", settings))


def api_json(settings, endpoint, payload=None, timeout=1800, local=False):
    try:
        with urllib.request.urlopen(request(settings, endpoint, payload, local), timeout=timeout) as response:
            return json.load(response)
    except (OSError, ValueError) as error:
        raise response_error(error, settings) from None


def prompt_tokens(settings, messages, count_text):
    if provider(settings) == "llama":
        formatted = api_json(settings, "/apply-template", {"messages": messages,
            "chat_template_kwargs": {"enable_thinking": settings["reasoning_effort"] != "none"}}, local=True)["prompt"]
        return count_text(formatted)
    # UTF-8 bytes conservatively upper-bound text tokens, not an exact tokenizer.
    # Include serialized role/message framing and extra provider template headroom.
    return len(json.dumps(messages, ensure_ascii=False).encode("utf-8")) + 512


def completion_payload(settings, messages, max_tokens, temperature, schema):
    budget = REASONING_BUDGETS[settings["reasoning_effort"]]
    kind = provider(settings)
    messages = list(messages)
    prompt_schema = schema is not None and kind in ("deepseek", "openai")
    if prompt_schema:
        instruction = ("Return only one JSON object matching this JSON Schema exactly; no prose, code fence or commentary.\n"
                       + json.dumps(schema, ensure_ascii=False))
        if messages and messages[0].get("role") == "system":
            messages[0] = {**messages[0], "content": messages[0]["content"] + "\n\n" + instruction}
        else:
            messages.insert(0, {"role": "system", "content": instruction})
    payload = {"model": settings["model"], "messages": messages, "stream": True,
               "max_tokens": max_tokens + budget,
               "temperature": max(0.6,temperature) if budget else temperature, "top_p": 0.9 if budget else 0.85, "presence_penalty": 0.0 if budget else 0.2,
               "stream_options": {"include_usage": True}}
    if kind == "siliconflow":
        payload["enable_thinking"] = budget > 0
        payload["top_k"] = 20
        if budget:
            payload["thinking_budget"] = budget
    elif kind == "llama":
        payload.update(top_k=30, min_p=0, repeat_penalty=1.05,
                       chat_template_kwargs={"enable_thinking": budget > 0}, reasoning_budget=budget)
    elif kind == "deepseek":
        payload["thinking"] = {"type": "enabled" if budget else "disabled"}
        if budget:
            payload["reasoning_effort"] = DEEPSEEK_EFFORT[settings["reasoning_effort"]]
            # Thinking mode ignores temperature and penalties; top_p must be 0.95–1.0.
            payload.pop("temperature", None)
            payload.pop("presence_penalty", None)
            payload["top_p"] = 0.95
    elif budget:
        payload["reasoning_effort"] = settings["reasoning_effort"]
    if schema:
        if prompt_schema:
            payload["response_format"] = {"type": "json_object"}
        else:
            payload["response_format"] = {"type": "json_schema", "json_schema": {
                "name": "review", "strict": True, "schema": schema}}
    return payload


def stream(settings, payload):
    try:
        response = urllib.request.urlopen(request(settings, "/chat/completions", payload), timeout=1800)
        with response:
            for line in response:
                if not line.startswith(b"data:"):
                    continue
                data = line[5:].strip()
                if data == b"[DONE]":
                    break
                event = json.loads(data)
                if event.get("error"):
                    raise ModelError(redact(event["error"], settings))
                yield event
    except (OSError, ValueError) as error:
        raise response_error(error, settings) from None
