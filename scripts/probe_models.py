#!/usr/bin/env python3
"""Probe every AI Studio chat model through the local proxy: plain chat + tool calling."""
import json
import urllib.request

PROXY = "http://127.0.0.1:3000/v1/chat/completions"

CHAT_MODELS = [
    "aliceai-llm/latest",
    "aliceai-llm-flash/latest",
    "yandexgpt-5.1/latest",
    "yandexgpt-5-pro/latest",
    "yandexgpt-5-lite/latest",
    "yandexgpt/latest",
    "yandexgpt-lite/latest",
    "yandexgpt-32k/latest",
    "qwen3.6-35b-a3b/latest",
    "qwen3-235b-a22b-fp8/latest",
    "gpt-oss-120b/latest",
    "gpt-oss-20b/latest",
    "deepseek-v4-flash/latest",
]

TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get current weather for a city",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]


def call(payload, timeout=90):
    req = urllib.request.Request(
        PROXY, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


for m in CHAT_MODELS:
    plain, tools = "ERR", "ERR"
    try:
        d = call({"model": m, "messages": [{"role": "user", "content": "Ответь одним словом: столица Франции?"}], "max_tokens": 30})
        plain = repr(d["choices"][0]["message"].get("content", ""))[:60]
    except Exception as e:
        plain = f"FAIL {type(e).__name__}: {str(e)[:90]}"
    try:
        d = call({"model": m,
                  "messages": [{"role": "user", "content": "Какая погода в Москве? Вызови инструмент."}],
                  "tools": TOOLS, "tool_choice": "auto", "max_tokens": 60})
        tc = d["choices"][0]["message"].get("tool_calls")
        tools = f"tool_calls={tc[0]['function']['name']}{tc[0]['function']['arguments']}" if tc else f"NO TOOL CALL (content={d['choices'][0]['message'].get('content','')[:40]!r})"
    except Exception as e:
        tools = f"FAIL {type(e).__name__}: {str(e)[:90]}"
    print(f"{m:28} | chat: {plain:40} | tools: {tools}")
