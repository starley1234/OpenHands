/**
 * Общий хелпер для прослоек-сервисов: общение с ЕДИНЫМ бэкендом (agent-server).
 *
 * Использует тот же путь, что и фронтенд Canvas:
 *   1. GET  /api/settings      с заголовком X-Expose-Secrets: encrypted
 *        → забирает текущие agent_settings (зашифрованные секреты LLM/MCP)
 *   2. POST /api/conversations с agent_settings + secrets_encrypted + initial_message
 *        → создаёт диалог (авто-запускается с initial_message)
 *   3. GET  /api/conversations/{id}  → опрос execution_status
 *
 * Так сервис не хардкодит LLM-ключи и настройки — берёт их с единого бэкенда.
 *
 * Переменные окружения:
 *   AGENT_SERVER_URL      — например http://localhost:8000 (или внутр. http://127.0.0.1:18000)
 *   AGENT_SERVER_API_KEY  — LOCAL_BACKEND_API_KEY, если бэкенд за авторизацией
 *   SERVICES_AGENT_DIR    — насколько глубоко «подняться» из services/<имя>/ до корня репозитория
 */

const baseUrl = (process.env.AGENT_SERVER_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const apiKey = process.env.AGENT_SERVER_API_KEY || "";

function headers(extra = {}) {
  const h = { "Content-Type": "application/json", ...extra };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

async function api(pathname, { method = "GET", body, exposeSecrets } = {}) {
  const h = headers(exposeSecrets ? { "X-Expose-Secrets": exposeSecrets } : {});
  const res = await fetch(`${baseUrl}/api${pathname}`, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`agent-server ${method} ${pathname} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

/** Забрать настройки агента (с зашифрованными секретами) — как это делает фронтенд. */
export async function getAgentSettingsForConversation() {
  const response = await api("/settings", { exposeSecrets: "encrypted" });
  return {
    agentSettings: response.agent_settings ?? {},
    conversationSettings: response.conversation_settings ?? {},
  };
}

/**
 * Создать диалог на едином бэкенде.
 *
 * @param {object} opts
 * @param {string} opts.workingDir  — абсолютный путь рабочей директории внутри бэкенда (например /projects/<subdir>)
 * @param {string} opts.prompt      — первое сообщение агенту (сценарий)
 * @param {number} [opts.maxIterations]
 * @param {Record<string,unknown>} [opts.agentSettings]  — если не переданы, берутся с бэкенда
 * @param {boolean} [opts.worktree]
 * @returns {Promise<{id:string, working_dir?:string|null}>}
 */
export async function startConversation({
  workingDir,
  prompt,
  maxIterations = 50,
  agentSettings,
  worktree = false,
}) {
  const settings =
    agentSettings ?? (await getAgentSettingsForConversation()).agentSettings;

  const payload = {
    agent_settings: settings,
    secrets_encrypted: true,
    workspace: { working_dir: workingDir },
    initial_message: {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
    max_iterations: maxIterations,
    stuck_detection: true,
    autotitle: true,
    worktree,
  };

  const created = await api("/conversations", { method: "POST", body: payload });
  return {
    id: String(created.id ?? created.conversation_id),
    working_dir: created.workspace?.working_dir ?? null,
  };
}

/** Получить статус диалога. */
export async function getConversationStatus(conversationId) {
  const info = await api(`/conversations/${conversationId}`);
  return {
    execution_status: info.execution_status ?? "unknown",
    id: String(info.id ?? conversationId),
    working_dir: info.workspace?.working_dir ?? null,
  };
}

const TERMINAL_STATUSES = new Set(["finished", "error", "stuck", "paused"]);

/**
 * Ждать завершения диалога, опрашивая статус.
 * @returns {Promise<{execution_status:string, id:string}>}
 */
export async function waitForCompletion(conversationId, { intervalMs = 3000, timeoutMs = 600000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await getConversationStatus(conversationId);
    if (TERMINAL_STATUSES.has(status.execution_status)) return status;
    if (Date.now() > deadline) {
      throw new Error(`Conversation ${conversationId} did not finish within ${timeoutMs}ms (status=${status.execution_status})`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
