#!/usr/bin/env bash
# ============================================================================
# Подключение моделей Yandex / Alice AI (через локальный прокси) к Hermes.
#
# Запускать НА СЕРВЕРЕ (в MobaXterm), от того пользователя, чей Hermes настраиваем:
#
#     bash /root/.hermes/health-assistant/alice-ai-hermes-proxy/deploy/connect-hermes.sh
#
# Что делает:
#   1. проверяет, что прокси отвечает на /healthz
#   2. регистрирует endpoint как custom provider → в `hermes model` появляется
#      строка с ЖИВЫМ списком моделей Yandex (и их окном контекста)
#   3. заводит короткие алиасы моделей (alice, alice-flash, ya-pro, ...)
#   4. проверяет результат реальным запросом через Hermes
#
# Переменные (необязательно):
#   BASE_URL=http://127.0.0.1:3000/v1   адрес прокси
#   MAKE_DEFAULT=1                      сделать Alice AI LLM моделью по умолчанию
#   SKIP_TEST=1                         не делать финальный тестовый запрос
#
# Скрипт идемпотентный: повторный запуск ничего не ломает.
# ============================================================================
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000/v1}"
BASE_URL="${BASE_URL%/}"                 # без хвостового слэша
ROOT_URL="${BASE_URL%/v1}"               # /healthz живёт в корне, а не под /v1
MAKE_DEFAULT="${MAKE_DEFAULT:-0}"
SKIP_TEST="${SKIP_TEST:-0}"
DEFAULT_MODEL="aliceai-llm/latest"
DEFAULT_CTX="131072"

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[0;32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[0;33m!\033[0m %s\n' "$*"; }
die()  { printf '   \033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v hermes >/dev/null 2>&1 || die "команда hermes не найдена в PATH"
say "0/5 Hermes: $(hermes --version 2>/dev/null | head -1)"

# ------------------------------------------------------------- 1. прокси
say "1/5 Проверка прокси"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="${APP_DIR}/proxy.log"
curl -sf -m 5 "${ROOT_URL}/healthz" >/dev/null \
    || die "прокси не отвечает на ${ROOT_URL}/healthz. Сначала: bash deploy/install-host.sh"
MODELS_JSON="$(curl -sf -m 20 "${BASE_URL}/models" || true)"
COUNT="$(printf '%s' "$MODELS_JSON" | grep -o '"id"' | wc -l | tr -d ' ')"
ok "прокси жив, моделей в каталоге: ${COUNT}"
# Старый экземпляр прокси держит порт и отдаёт свой короткий статический список.
# Лучше остановиться сейчас, чем настроить Hermes на мёртвый/устаревший процесс.
if [ "${COUNT:-0}" -lt 10 ]; then
    warn "каталог подозрительно короткий (у актуального прокси ~23 модели)."
    warn "Похоже, порт держит СТАРЫЙ экземпляр прокси. Останови его и поставь заново:"
    warn "  bash ${APP_DIR}/deploy/kill-stale-proxy.sh && bash ${APP_DIR}/deploy/install-host.sh"
    die "остановлено, чтобы не настраивать Hermes на устаревший прокси"
fi

# --------------------------------------------- 2. регистрация endpoint
say "2/5 Регистрируем endpoint в Hermes"
EXISTING="$(hermes config get custom_providers --json 2>/dev/null || echo 'null')"
if printf '%s' "$EXISTING" | grep -q '127.0.0.1:3000'; then
    ok "endpoint уже прописан в custom_providers — пропускаю"
elif [ "$EXISTING" = "null" ] || [ -z "$EXISTING" ] || [ "$EXISTING" = "[]" ]; then
    hermes config set custom_providers \
        "[{\"name\":\"alice\",\"base_url\":\"${BASE_URL}\",\"api_key\":\"dummy\",\"model\":\"${DEFAULT_MODEL}\"}]" >/dev/null
    ok "добавлен custom provider \"alice\" (${BASE_URL})"
else
    warn "в custom_providers уже есть другие записи — ничего не перезаписываю."
    warn "текущее значение: $(printf '%s' "$EXISTING" | head -c 200)"
    warn "проще всего добавить endpoint через интерактивный выбор: hermes model → Custom endpoint"
    warn "  base_url: ${BASE_URL}   api_key: dummy   model: ${DEFAULT_MODEL}"
fi

# ----------------------------------------------------- 3. алиасы моделей
say "3/5 Алиасы моделей (переключение через /model <алиас>)"
set_alias() {  # $1 = имя, $2 = model id
    hermes config set "model_aliases.$1.model"    "$2"        >/dev/null
    hermes config set "model_aliases.$1.provider" custom      >/dev/null
    hermes config set "model_aliases.$1.base_url" "$BASE_URL" >/dev/null
    printf '   \033[0;32m✓\033[0m %-12s → %s\n' "$1" "$2"
}
set_alias alice       aliceai-llm/latest
set_alias alice-flash aliceai-llm-flash/latest
set_alias ya-pro      yandexgpt-5-pro/latest
set_alias ya-lite     yandexgpt-5-lite/latest
set_alias qwen-ya     qwen3.6-35b-a3b/latest
set_alias oss-ya      gpt-oss-120b/latest
set_alias ds-ya       deepseek-v4-flash/latest

# ------------------------------------------------- 4. модель по умолчанию
if [ "$MAKE_DEFAULT" = "1" ]; then
    say "4/5 Alice AI LLM как модель по умолчанию"
    hermes config set model.provider       custom   >/dev/null
    hermes config set model.base_url       "$BASE_URL" >/dev/null
    hermes config set model.default        "$DEFAULT_MODEL" >/dev/null
    hermes config set model.context_length "$DEFAULT_CTX" >/dev/null
    ok "основная модель: ${DEFAULT_MODEL} (контекст ${DEFAULT_CTX})"
else
    say "4/5 Модель по умолчанию"
    ok "не меняю. Чтобы сделать Alice AI LLM основной: MAKE_DEFAULT=1 bash $0"
fi

# ------------------------------------------------------------ 5. проверка
say "5/5 Проверка"
hermes config get model_aliases --json 2>/dev/null | head -c 400; echo
if [ "$SKIP_TEST" != "1" ]; then
    # Проверяем не «ответ вообще», а именно то, что запрос ушёл в НАШ прокси: берём
    # алиас alice (он жёстко смотрит на этот base_url) и сверяем счётчик запросов,
    # который прокси отдаёт в /healthz.
    BEFORE="$(curl -sf -m 5 "${ROOT_URL}/healthz" | grep -o '"requests":[0-9]*' | cut -d: -f2)"
    printf '   делаю тестовый запрос через Hermes (модель alice, ~10 секунд)\n'
    OUT="$(timeout 180 hermes chat -q "Ответь одним словом: столица Франции?" -m alice 2>&1 || true)"
    printf '%s\n' "$OUT" | tail -3 | sed 's/^/     /'
    AFTER="$(curl -sf -m 5 "${ROOT_URL}/healthz" | grep -o '"requests":[0-9]*' | cut -d: -f2)"
    LAST_MODEL="$(curl -sf -m 5 "${ROOT_URL}/healthz" | grep -o '"last_model":"[^"]*"' | cut -d'"' -f4)"
    if [ -n "$AFTER" ] && [ -n "$BEFORE" ] && [ "$AFTER" -gt "$BEFORE" ] && printf '%s' "$OUT" | grep -qiE 'париж'; then
        ok "запрос дошёл до прокси (счётчик ${BEFORE} → ${AFTER}, модель ${LAST_MODEL}) и Yandex ответил"
    elif [ -n "$AFTER" ] && [ -n "$BEFORE" ] && [ "$AFTER" -gt "$BEFORE" ]; then
        warn "запрос дошёл до прокси (${BEFORE} → ${AFTER}), но «Париж» в ответе не видно — смотри вывод выше"
    else
        warn "счётчик запросов прокси не вырос: Hermes НЕ пошёл через прокси."
        warn "проверь: hermes config get model_aliases --json | head -c 300"
    fi
fi

cat <<EOF

============================================================================
Готово.

В интерактивной сессии Hermes:
    /model                — список (внутри строки "alice" будет живой список моделей Yandex)
    /model alice          — переключиться на Alice AI LLM
    /model qwen-ya        — переключиться на Qwen3.6 35B

Полный список моделей с окном контекста:
    curl -s ${BASE_URL}/models
============================================================================
EOF
