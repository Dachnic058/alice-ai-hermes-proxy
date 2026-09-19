#!/usr/bin/env python3
"""Прогон ОДНОЙ и той же делегированной задачи через разные модели-воркеры.

Проверяем не «ответ вообще», а два факта из базы Hermes:
  1) создалась ли дочерняя сессия (source='subagent') — то есть воркер реально был;
  2) какую команду воркер выполнил и что вернул — сверяем с истиной (ls /workspace | wc -l).
"""
import json
import os
import sqlite3
import subprocess
import sys

HOME = "/workspace/hx/home10"
HERMES = "/workspace/hx/venv/bin/hermes"
WORKER_SCRIPT = "/workspace/health-assistant/alice-ai-hermes-proxy/deploy/connect-worker.sh"
TASK = ("Делегируй субагенту: командой ls /workspace | wc -l посчитать число файлов "
        "и вернуть только число. Потом сообщи, что вернул субагент.")
TRUTH = int(subprocess.run("ls /workspace | wc -l", shell=True, capture_output=True, text=True).stdout.strip())

CANDIDATES = sys.argv[1:] or [
    "aliceai-llm/latest",
    "gpt-oss-120b/latest",
    "qwen3-235b-a22b-fp8/latest",
    "deepseek-v4-flash/latest",
]


def sh(cmd, env=None, timeout=400):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, env=env, timeout=timeout)


def child_report(home):
    db = os.path.join(home, "state.db")
    con = sqlite3.connect(db)
    cur = con.cursor()
    row = cur.execute("select id, model from sessions where source='subagent' order by rowid desc limit 1").fetchone()
    if not row:
        return None, None, None, None
    sid, model = row
    cmd, out, final = None, None, None
    for role, content, tc in cur.execute("select role, content, tool_calls from messages where session_id=? order by id", (sid,)):
        if role == "assistant" and tc and not cmd:
            try:
                cmd = json.loads(tc)[0]["function"]["arguments"]
            except Exception:
                cmd = tc[:120]
        if role == "tool" and out is None:
            out = (content or "")[:80]
        if role == "assistant" and content:
            final = content[:160]
    return model, cmd, out, final


# общий дом: голова на своём алиасе через прокси
env = dict(os.environ, HERMES_HOME=HOME, PATH="/workspace/hx/venv/bin:" + os.environ["PATH"])
sh(f"rm -rf {HOME} && mkdir -p {HOME}", env=env)
for cmd in (
    "hermes config set custom_providers '[{\"name\":\"alice\",\"base_url\":\"http://127.0.0.1:3000/v1\",\"api_key\":\"dummy\",\"model\":\"aliceai-llm/latest\"}]'",
    "hermes config set model.provider alice",
    "hermes config set model.default aliceai-llm/latest",
    "hermes config set model.context_length 131072",
):
    sh(cmd, env=env)

print(f"ИСТИНА (ls /workspace | wc -l) = {TRUTH}\n")
for model in CANDIDATES:
    sh(f'WORKER_MODEL={model} bash {WORKER_SCRIPT}', env=env)
    before = sh("ls -1 " + HOME + " | grep -c .", env=env).stdout.strip()
    run = sh(f'hermes chat -q "{TASK}"', env=env)
    tail = (run.stdout or "").strip().splitlines()[-6:]
    wmodel, wcmd, wout, wfinal = child_report(HOME)
    ok = "OK" if wout and str(TRUTH) in wout else "ПРОВАЛ"
    print(f"### воркер {model}")
    print(f"    сессия субагента: {wmodel or 'НЕ СОЗДАНА'}")
    print(f"    команда воркера:  {wcmd}")
    print(f"    вывод инструмента:{wout}")
    print(f"    финал воркера:    {wfinal}")
    print(f"    сверка с истиной: {ok}")
    print(f"    реплика головы:   {[l for l in tail if 'убагент' in l][:1]}")
    print()
