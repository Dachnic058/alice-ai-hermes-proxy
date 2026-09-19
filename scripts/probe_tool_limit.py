#!/usr/bin/env python3
"""How many tools can each Yandex-hosted model handle before it stops emitting real
OpenAI tool_calls and answers with text (a fenced / [TOOL_CALL_END] markup) instead?"""
import json
import urllib.request

PROXY = "http://127.0.0.1:3000/v1/chat/completions"


def tool(i):
    return {
        "type": "function",
        "function": {
            "name": f"tool_{i}",
            "description": f"Utility tool number {i} used for testing the tool-calling path",
            "parameters": {
                "type": "object",
                "properties": {"arg": {"type": "string", "description": "argument"}},
                "required": ["arg"],
            },
        },
    }


def probe(model, n_tools):
    tools = [tool(i) for i in range(n_tools - 1)]
    tools.append({
        "type": "function",
        "function": {
            "name": "terminal",
            "description": "Run a shell command",
            "parameters": {"type": "object",
                           "properties": {"command": {"type": "string"}},
                           "required": ["command"]},
        },
    })
    payload = {
        "model": model,
        "max_tokens": 200,
        "messages": [{"role": "user", "content": "Запусти команду ls /workspace через инструмент terminal."}],
        "tools": tools,
        "tool_choice": "auto",
    }
    req = urllib.request.Request(PROXY, data=json.dumps(payload).encode(),
                                headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001
        return f"ERR {type(e).__name__}: {str(e)[:60]}"
    msg = d["choices"][0]["message"]
    if msg.get("tool_calls"):
        return "tool_calls OK"
    content = (msg.get("content") or "").replace("\n", " ")[:70]
    return f"TEXT: {content!r}"


for model in ("aliceai-llm/latest", "aliceai-llm-flash/latest", "qwen3.6-35b-a3b/latest"):
    row = []
    for n in (1, 5, 10, 20, 30):
        row.append(f"n={n}: {probe(model, n)}")
    print(f"### {model}")
    for r in row:
        print("   ", r)
