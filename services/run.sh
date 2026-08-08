#!/usr/bin/env bash
# Запуск прослоек-сервисов (book-site, docs-site, meeting-notes).
# Единый бэкенд должен быть поднят:  docker compose up -d --build
#
# Использование:
#   ./services/run.sh                 # запустить все сервисы
#   ./services/run.sh book-site       # запустить один
#
# Переменные:
#   AGENT_SERVER_URL     (по умолчанию http://localhost:8000)
#   AGENT_SERVER_API_KEY (LOCAL_BACKEND_API_KEY)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export AGENT_SERVER_URL="${AGENT_SERVER_URL:-http://localhost:8000}"
export AGENT_SERVER_API_KEY="${AGENT_SERVER_API_KEY:-}"
export HOST_WORK_ROOT="${HOST_WORK_ROOT:-$ROOT/projects}"

SERVICES=(book-site docs-site meeting-notes)

run_one() {
  local name="$1"
  if [ ! -d "$ROOT/services/$name" ] || [ ! -f "$ROOT/services/$name/server.mjs" ]; then
    echo "Сервис '$name' не найден. Доступны: ${SERVICES[*]}" >&2
    return 1
  fi
  local port
  port="$(python3 -c "import json;print(json.load(open('$ROOT/services/$name/config.json'))['port'])" 2>/dev/null || echo '?')"
  echo "[run.sh] Запускаю $name на :$port (AGENT_SERVER_URL=$AGENT_SERVER_URL)"
  cd "$ROOT/services/$name"
  exec node server.mjs
}

if [ "$#" -gt 0 ]; then
  run_one "$1"
  exit $?
fi

# Все сервисы параллельно
pids=()
for s in "${SERVICES[@]}"; do
  ( run_one "$s" ) &
  pids+=("$!")
done
echo "[run.sh] Запущено ${#pids[@]} сервисов. Остановить: Ctrl+C"
wait
