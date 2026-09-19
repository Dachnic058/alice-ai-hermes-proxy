#!/usr/bin/env bash
# ============================================================================
# alice-ai-proxy — установка прокси Alice AI / YandexGPT как системного сервиса
#
# Запускать НА СЕРВЕРЕ (в MobaXterm), где работает Hermes, от root:
#
#     bash /root/.hermes/health-assistant/alice-ai-hermes-proxy/deploy/install-host.sh
#
# Что делает:
#   1. проверяет каталог проекта и .env (FOLDER_ID + API_KEY)
#   2. проверяет Node.js (>=18), при отсутствии — ставит через apt
#   3. доставляет npm-зависимости, если их нет
#   4. ставит systemd-сервис alice-ai-proxy (автозапуск + авторестарт)
#   5. если systemd нет — поднимает через nohup и добавляет @reboot в crontab
#   6. проверяет: /healthz, каталог моделей и реальный ответ модели
#
# Скрипт идемпотентный — можно запускать повторно.
# ============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/root/.hermes/health-assistant/alice-ai-hermes-proxy}"
SERVICE_NAME="alice-ai-proxy"
PORT="${PORT:-3000}"
BASE_URL="http://127.0.0.1:${PORT}/v1"

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[0;32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[0;33m!\033[0m %s\n' "$*"; }
die()  { printf '   \033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. проект
say "1/6 Каталог проекта"
[ -d "$APP_DIR" ] || die "нет каталога $APP_DIR"
cd "$APP_DIR"
[ -f src/server.js ] || die "нет src/server.js в $APP_DIR"
[ -f .env ] || die "нет .env — впиши FOLDER_ID и API_KEY"
grep -qE '^FOLDER_ID=.+' .env || die "в .env не заполнен FOLDER_ID"
if ! grep -qE '^(API_KEY|YC_API_KEY|IAM_TOKEN|SA_JSON|SA_JSON_PATH)=.+' .env; then
    die "в .env нет ни API_KEY, ни IAM_TOKEN, ни SA_JSON"
fi
ok "проект на месте, .env заполнен"

# ------------------------------------------------------------------- 2. node
say "2/6 Node.js"
node_major() { node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0; }

if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge 18 ]; then
    NODE_BIN="$(command -v node)"
    ok "node $NODE_BIN ($(node -v))"
else
    warn "подходящего node нет — ставлю из apt"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y -qq >/dev/null
    apt-get install -y -qq nodejs npm >/dev/null
    NODE_BIN="$(command -v node)"
    [ "$(node_major)" -ge 18 ] || die "apt поставил node $(node -v) — нужен >=18"
    ok "node $NODE_BIN ($(node -v))"
fi

# ------------------------------------------------------------- 3. npm пакеты
say "3/6 npm-зависимости"
if [ -d node_modules ] && node -e "require('express')" >/dev/null 2>&1; then
    ok "node_modules уже на месте"
else
    (command -v npm >/dev/null 2>&1 && npm install --omit=dev --no-audit --no-fund) \
        || "$(dirname "$NODE_BIN")/npm" install --omit=dev --no-audit --no-fund
    node -e "require('express')" >/dev/null 2>&1 || die "npm install не помог — express не найден"
    ok "зависимости установлены"
fi

# ---------------------------------------------------------------- 4. сервис
say "4/6 Автозапуск (systemd)"
STARTED_VIA_SYSTEMD=false
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Alice AI / YandexGPT OpenAI-compatible proxy for Hermes
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} src/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
StandardOutput=append:${APP_DIR}/proxy.log
StandardError=append:${APP_DIR}/proxy.log

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
    systemctl restart "$SERVICE_NAME"
    sleep 2
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        ok "systemd-сервис ${SERVICE_NAME} активен, автозапуск включён"
        STARTED_VIA_SYSTEMD=true
    else
        warn "сервис не поднялся, смотри: journalctl -u ${SERVICE_NAME} -n 50"
    fi
else
    warn "systemd недоступен — поднимаю через nohup + @reboot"
fi

# ------------------------------------------------------------ 5. fallback
if [ "$STARTED_VIA_SYSTEMD" != true ]; then
    for pid in $(pgrep -x node 2>/dev/null || true); do
        if tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null | grep -q 'src/server\.js'; then kill "$pid" || true; fi
    done
    sleep 1
    nohup "$NODE_BIN" src/server.js >> proxy.log 2>&1 &
    sleep 2
    ok "запущено через nohup (pid $!), лог: $APP_DIR/proxy.log"
    REBOOT_CMD="cd ${APP_DIR} && nohup ${NODE_BIN} src/server.js >> proxy.log 2>&1 &"
    if command -v crontab >/dev/null 2>&1; then
        ( crontab -l 2>/dev/null | grep -v 'alice-ai-hermes-proxy'; \
          echo "@reboot ${REBOOT_CMD}" ) | crontab -
        ok "добавлен автозапуск @reboot в crontab"
    else
        warn "crontab нет — после перезагрузки запусти вручную: ${REBOOT_CMD}"
    fi
fi

# ------------------------------------------------------------- 6. проверка
say "5/6 Проверка здоровья"
for _ in $(seq 1 15); do
    curl -sf -m 3 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 && break
    sleep 1
done
curl -sf -m 5 "http://127.0.0.1:${PORT}/healthz" >/dev/null \
    || die "прокси не отвечает на /healthz — проверь $APP_DIR/proxy.log"
ok "/healthz отвечает"

MODELS_JSON="$(curl -sf -m 20 "${BASE_URL}/models" || true)"
if [ -n "$MODELS_JSON" ]; then
    COUNT="$(printf '%s' "$MODELS_JSON" | grep -o '"id"' | wc -l | tr -d ' ')"
    ok "каталог моделей: ${COUNT} шт."
else
    warn "каталог моделей не получен (проверь интернет и ключи)"
fi

say "6/6 Реальный запрос к модели через прокси"
REPLY="$(curl -sf -m 60 "${BASE_URL}/chat/completions" \
    -H 'Content-Type: application/json' \
    -d '{"model":"aliceai-llm/latest","messages":[{"role":"user","content":"Ответь одним словом: столица Франции?"}]}' || true)"
if printf '%s' "$REPLY" | grep -q '"content"'; then
    ok "Yandex ответил: $(printf '%s' "$REPLY" | head -c 200)"
else
    warn "ответа нет. Текст: ${REPLY:0:300}"
    warn "проверь ключи в .env и лог: tail -30 ${APP_DIR}/proxy.log"
fi

cat <<EOF

============================================================================
Готово. Прокси слушает ${BASE_URL} и поднимается сам после перезагрузки.

Дальше — подключение моделей к Hermes (одна команда):
    bash ${APP_DIR}/deploy/connect-hermes.sh

Проверка вручную в любой момент:
    curl -s ${BASE_URL}/models | head -c 400
============================================================================
EOF
