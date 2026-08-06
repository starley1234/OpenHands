#!/bin/bash
# Автономный stop-hook: «пинает» агента, запрещая преждевременный finish.
#
# Что делает:
#   - В автономном режиме (AUTONOMOUS_MODE=1) блокирует первый finish-вызов
#     и возвращает агенту feedback «продолжай — сначала убедись, что всё
#     сделано», чтобы он реально доделал работу.
#   - Число блокировок ограничено (AUTONOMOUS_MAX_PINGS, по умолчанию 5),
#     чтобы не зациклить агента навсегда: после N пингов он может
#     завершиться.
#
# Как подключить:
#   Скопируй этот файл и hooks.json в рабочее пространство агента:
#     /projects/.openhands/hooks.json
#     /projects/.openhands/hooks/on_stop.sh   (сделай chmod +x)
#   Задай переменную окружения: AUTONOMOUS_MODE=1
#
# Формат ответа хука:
#   exit 0 + JSON {"decision":"deny","additionalContext":"..."}  -> блокировать finish
#   exit 0 + JSON {"decision":"allow"}                            -> разрешить finish

set -uo pipefail

# Автономный режим выключен -> не вмешиваемся.
if [ "${AUTONOMOUS_MODE:-0}" != "1" ]; then
  echo '{"decision":"allow"}'
  exit 0
fi

PROJECT_DIR="${OPENHANDS_PROJECT_DIR:-$(pwd)}"
STATE_FILE="${PROJECT_DIR}/.openhands/.autonomous_ping_count"

# Сколько раз уже «пинали» в этой сессии.
PING_COUNT=0
if [ -f "$STATE_FILE" ]; then
  PING_COUNT=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
fi

MAX_PINGS="${AUTONOMOUS_MAX_PINGS:-5}"

if [ "$PING_COUNT" -lt "$MAX_PINGS" ]; then
  PING_COUNT=$((PING_COUNT + 1))
  printf '%s' "$PING_COUNT" > "$STATE_FILE"

  >&2 echo "[autonomous-hook] Пинг #$PING_COUNT из $MAX_PINGS: задача ещё не завершена, продолжаю."

  # Блокируем finish и пинаем агента.
  cat <<JSON
{"decision":"deny","additionalContext":"Ты работаешь в автономном режиме. Ты попытался завершить задачу, но это ещё не финал. Продолжай: выполни все шаги плана, проверь результат (код, тесты, вывод), и только когда задача реально готова — вызови finish с итоговым отчётом. Если упёрся в тупик — смени подход или явно опиши, что именно заблокировано."}
JSON
  exit 0
fi

# Лимит пингов исчерпан — разрешаем завершить (чтобы не зациклить).
>&2 echo "[autonomous-hook] Достигнут лимит пингов ($MAX_PINGS), разрешаю finish."
echo '{"decision":"allow"}'
exit 0
