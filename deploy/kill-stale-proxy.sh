#!/usr/bin/env bash
# ============================================================================
# Останавливает прежние экземпляры прокси, которые держат порт 3000
# (обычно запущенные когда-то вручную через nohup). Без fuser/lsof —
# они есть не на каждом сервере.
#
#     bash /root/.hermes/health-assistant/alice-ai-hermes-proxy/deploy/kill-stale-proxy.sh
#
# Скрипт НЕ трогает чужие node-процессы: сначала сверяет рабочий каталог процесса
# с каталогом проекта, и только потом завершает его.
# ============================================================================
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
PORT="${PORT:-3000}"
APP_REAL="$(readlink -f "$APP_DIR")"

say()  { printf '\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[0;32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[0;33m!\033[0m %s\n' "$*"; }

say "Ищу экземпляры прокси проекта"
killed=0
for pid in $(pgrep -x node 2>/dev/null || true); do
    cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
    cmd="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
    case "$cmd" in *server.js*) : ;; *) continue ;; esac   # не наш сервер — не трогаем
    if [ "$cwd" = "$APP_REAL" ]; then
        if kill "$pid" 2>/dev/null; then ok "остановлен pid ${pid} (cwd ${cwd})"; killed=$((killed + 1)); fi
    elif [ -n "$cmd" ]; then
        warn "похожий процесс ${pid} из ДРУГОГО каталога (${cwd:-?}): ${cmd}"
        warn "если это он держит порт — останови вручную: kill ${pid}"
    fi
done
[ "$killed" -eq 0 ] && warn "своих экземпляров не найдено"
sleep 1

say "Кто слушает порт ${PORT}"
# Поиск владельца сокета только средствами /proc + python3 (есть везде, где есть Hermes).
PORT_HEX="$(printf '%04X' "$PORT")"
HOLDER="$(PORT_HEX="$PORT_HEX" python3 - <<'PY' 2>/dev/null || true
import os, glob
want = os.environ['PORT_HEX']
inodes = set()
for path in ('/proc/net/tcp', '/proc/net/tcp6'):
    try:
        lines = open(path).read().splitlines()[1:]
    except OSError:
        continue
    for line in lines:
        f = line.split()
        if len(f) > 9 and f[3] == '0A' and f[1].split(':')[-1] == want:
            inodes.add(f[9])
if not inodes:
    raise SystemExit(0)
for entry in os.listdir('/proc'):
    if not entry.isdigit():
        continue
    try:
        for fd in glob.glob('/proc/%s/fd/*' % entry):
            try:
                target = os.readlink(fd)
            except OSError:
                continue
            if target.startswith('socket:[') and target[8:-1] in inodes:
                cmd = open('/proc/%s/cmdline' % entry, 'rb').read().replace(b'\0', b' ').decode(errors='replace').strip()
                print(f'{entry} {cmd}')
                break
    except OSError:
        continue
PY
)"

if [ -n "$HOLDER" ]; then
    printf '%s\n' "$HOLDER" | sed 's/^/   /'
    warn "порт ${PORT} всё ещё занят. Это не каталог проекта — реши сам, гасить ли:"
    printf '%s\n' "$HOLDER" | awk '{print "     kill -9 " $1}' | sed 's/^/   /'
    exit 1
fi

if curl -sf -m 2 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    warn "на порту ${PORT} кто-то отвечает, но владельца найти не удалось (права?)"
    exit 1
fi

ok "порт ${PORT} свободен — можно поднимать прокси:"
printf '   bash %s/deploy/install-host.sh\n' "$APP_DIR"
