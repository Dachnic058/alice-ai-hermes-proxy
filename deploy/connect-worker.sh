#!/usr/bin/env bash
# ============================================================================
# Назначение роли «воркер» в Hermes: субагенты (delegate_task) ходят не на модель
# головы, а на выбранную модель нашего прокси.
#
#     bash /root/.hermes/health-assistant/alice-ai-hermes-proxy/deploy/connect-worker.sh
#     WORKER_MODEL=aliceai-llm-flash/latest bash deploy/connect-worker.sh   # сменить воркера
#
# Проверено на Hermes v0.21.3: голова (например deepseek) вызывает субагента, и
# запросы субагента уходят на указанную модель — это видно в proxy.log строками
#   [proxy] POST /v1/chat/completions model=gpt://<folder>/qwen3.6-35b-a3b/latest -> 200
# ============================================================================
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000/v1}"
BASE_URL="${BASE_URL%/}"
ROOT_URL="${BASE_URL%/v1}"
WORKER_MODEL="${WORKER_MODEL:-qwen3.6-35b-a3b/latest}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

ok()   { printf '   \033[0;32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[0;33m!\033[0m %s\n' "$*"; }
die()  { printf '   \033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v hermes >/dev/null 2>&1 || die "команда hermes не найдена в PATH"

printf '\n\033[1;36m== 1/3 Прокси\033[0m\n'
curl -sf -m 5 "${ROOT_URL}/healthz" >/dev/null || die "прокси не отвечает на ${ROOT_URL}/healthz"
MISSING="$(curl -sf -m 20 "${BASE_URL}/models" | grep -c "\"id\":\"${WORKER_MODEL}\"" || true)"
[ "${MISSING:-0}" -ge 1 ] || die "модели ${WORKER_MODEL} нет в каталоге прокси: curl -s ${BASE_URL}/models"
ok "прокси жив, модель ${WORKER_MODEL} в каталоге есть"

printf '\n\033[1;36m== 2/3 Прописываю воркера для субагентов\033[0m\n'
hermes config set delegation.base_url "$BASE_URL" >/dev/null
hermes config set delegation.model    "$WORKER_MODEL" >/dev/null
hermes config set delegation.api_key  dummy >/dev/null
ok "delegation.base_url = ${BASE_URL}"
ok "delegation.model    = ${WORKER_MODEL}"
ok "delegation.api_key  = dummy (прокси ключ не проверяет)"

printf '\n\033[1;36m== 3/3 Что получилось\033[0m\n'
hermes config get delegation --json 2>/dev/null | head -c 400; echo
cat <<EOF

Дальше — живая проверка (когда будет задача):
  1. дай задачу голове; она вызовет субагента;
  2. в логе прокси появятся строки с моделью субагента:
       tail -f ${APP_DIR}/proxy.log | grep "chat/completions"
  3. если субагенту нужна другая модель — перезапусти скрипт с её id:
       WORKER_MODEL=gpt-oss-120b/latest bash ${APP_DIR}/deploy/connect-worker.sh

Откатить (субагент снова на модели головы):
  hermes config unset delegation.base_url
  hermes config unset delegation.model
  hermes config unset delegation.api_key
============================================================================
EOF
