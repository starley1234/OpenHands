#!/usr/bin/env node
/**
 * Прослойка-сервис «книга → сайт».
 *
 * Тонкий HTTP-сервис, который:
 *  1. слушает свой порт (8290),
 *  2. отдаёт тонкий фронтенд (web/) и опубликованную статику (out/),
 *  3. по POST /api/run создаёт диалог на ЕДИНОМ бэкенде (agent-server),
 *  4. по GET /api/status опрашивает статус диалога,
 *  5. по GET /api/result читает написанные агентом главы из проекта и
 *     собирает статический сайт в out/.
 *
 * Ничего не форкает: единый бэкенд — единственный исполнитель. Сервис лишь
 * инкапсулирует настройки функции и прячет их от пользовательского фронтенда.
 */
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  await readFile(path.join(__dirname, "config.json"), "utf-8"),
);

// ── Единый бэкенд ───────────────────────────────────────────────────────────
// AGENT_SERVER_URL, AGENT_SERVER_API_KEY — как у основного фронтенда.
// Прослойка использует REST API agent-server (создание диалога, статус, файлы).
const AGENT_SERVER_URL = (process.env.AGENT_SERVER_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const AGENT_SERVER_API_KEY = process.env.AGENT_SERVER_API_KEY || "";
const API_BASE = `${AGENT_SERVER_URL}/api`;

async function agentFetch(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(AGENT_SERVER_API_KEY ? { Authorization: `Bearer ${AGENT_SERVER_API_KEY}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`agent-server ${method} ${pathname} -> ${res.status}: ${text}`);
  }
  return res.json();
}

// Состояние текущей задачи (одна книга за раз — для примера; для многих задач
// замените на Map<id, state>).
const state = {
  conversationId: null,
  status: "idle", // idle | running | finished | error
  error: null,
  workingDir: null,
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".md": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function serveStatic(res, baseDir, urlPath) {
  const target = path.normalize(path.join(baseDir, decodeURIComponent(urlPath)));
  if (!target.startsWith(path.resolve(baseDir))) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  const p = existsSync(target) && (await stat(target)).isDirectory()
    ? path.join(target, "index.html")
    : target;
  try {
    const data = await readFile(p);
    const ext = path.extname(p).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

async function handleRun(body) {
  const subject = (body && body.subject || "").trim();
  if (!subject) return { ok: false, error: "subject is required" };

  const title = (config.scenario.title_template || "{{subject}}").replace("{{subject}}", subject);
  const prompt = [
    config.scenario.system_prompt,
    "",
    `Тема книги: ${subject}`,
    "",
    `Записывай главы в подпапку проекта '${config.project_subdir}' проекта.`,
  ].join("\n");

  // Создать диалог на едином бэкенде (пример; уточните поля по реальному
  // контракту agent-server / Canvas).
  const created = await agentFetch("/conversations", {
    method: "POST",
    body: {
      initial_message: { role: "user", content: prompt },
      title,
      conversation_instructions: prompt,
    },
  });

  state.conversationId = created.id ?? created.conversation_id ?? created.app_conversation_id ?? null;
  state.status = "running";
  state.error = null;
  state.workingDir = created.workspace?.working_dir ?? null;
  return { ok: true, conversation_id: state.conversationId };
}

async function handleStatus() {
  if (!state.conversationId) return { status: state.status, conversation_id: null };
  try {
    const info = await agentFetch(`/conversations/${state.conversationId}`);
    const status = info.execution_status ?? "running";
    if (["finished", "error", "stuck"].includes(status)) {
      state.status = status === "finished" ? "finished" : "error";
      await buildSite();
    }
    return { status: state.status, conversation_id: state.conversationId };
  } catch (err) {
    return { status: state.status, conversation_id: state.conversationId, error: String(err) };
  }
}

async function handleResult() {
  const chapters = await readChapters();
  return { ok: true, chapters, site_url: `http://localhost:${config.port}/out/index.html` };
}

async function readChapters() {
  // Агент пишет главы в <workingDir>/<project_subdir>/*.md
  if (!state.workingDir) return [];
  const dir = path.join(state.workingDir, config.project_subdir);
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
    const out = [];
    for (const f of files) {
      const text = await readFile(path.join(dir, f), "utf-8");
      out.push({ file: f, text });
    }
    return out;
  } catch {
    return [];
  }
}

async function buildSite() {
  // Статик-генератор: главы -> простой HTML-сайт в out/.
  const outDir = path.join(__dirname, "out");
  await mkdir(outDir, { recursive: true });
  const chapters = await readChapters();
  const toc = chapters.map((c, i) => `<li><a href="#c${i}">${c.file}</a></li>`).join("\n");
  const body = chapters
    .map((c, i) => {
      const html = escapeHtml(c.text);
      return `<h2 id="c${i}">${escapeHtml(c.file)}</h2><pre class="chapter">${html}</pre>`;
    })
    .join("\n");
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Книга</title>
<style>body{font-family:sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;line-height:1.6}
pre.chapter{white-space:pre-wrap;background:#f7f7f8;padding:1rem;border-radius:8px}</style>
</head><body><h1>Книга</h1><ul>${toc}</ul>${body}</body></html>`;
  await writeFile(path.join(outDir, "index.html"), html, "utf-8");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/health") return res.writeHead(200).end("ok");
    if (url.pathname === "/api/run" && req.method === "POST") {
      const body = JSON.parse(await readRequestBody(req) || "{}");
      const result = await handleRun(body);
      return res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    }
    if (url.pathname === "/api/status") {
      const s = await handleStatus();
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(s));
    }
    if (url.pathname === "/api/result") {
      const r = await handleResult();
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(r));
    }
    if (url.pathname.startsWith("/out/")) return serveStatic(res, path.join(__dirname, "out"), url.pathname.replace(/^\/out/, ""));
    return serveStatic(res, path.join(__dirname, "web"), url.pathname === "/" ? "/index.html" : url.pathname);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(err) }));
  }
});

function readRequestBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

server.listen(config.port, "0.0.0.0", () => {
  console.log(`[book-site] listening on http://0.0.0.0:${config.port}`);
});
