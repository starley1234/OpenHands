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
 *
 * Пути: бэкенд работает внутри контейнера и видит рабочую директорию как
 * /projects/<subdir>. Сервис запускается на хосте и читает те же файлы как
 * ./projects/<subdir>. Маппинг задаётся env-переменными (см. ниже).
 */
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  startConversation,
  getConversationStatus,
} from "../lib/agent-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  await readFile(path.join(__dirname, "config.json"), "utf-8"),
);

// ── Маппинг путей контейнер ↔ хост ─────────────────────────────────────────
// AGENT_WORK_ROOT  — где внутри контейнера лежит рабочая директория (по умолч. /projects)
// HOST_WORK_ROOT   — где на хосте лежит та же директория (по умолч. <корень>/projects)
const AGENT_WORK_ROOT = (process.env.AGENT_WORK_ROOT || "/projects").replace(/\/+$/, "");
const HOST_WORK_ROOT = (
  process.env.HOST_WORK_ROOT || path.resolve(__dirname, "..", "..", "projects")
).replace(/\/+$/, "");

/** container /projects/<sub> -> host ./projects/<sub> */
function agentToHostDir(agentDir) {
  if (!agentDir) return null;
  if (agentDir.startsWith(AGENT_WORK_ROOT)) {
    return path.join(HOST_WORK_ROOT, agentDir.slice(AGENT_WORK_ROOT.length).replace(/^\/+/, ""));
  }
  return agentDir;
}

const state = {
  conversationId: null,
  status: "idle", // idle | running | finished | error
  error: null,
  agentWorkDir: null,
  hostWorkDir: null,
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

  // Уникальная подпапка проекта под эту книгу.
  const sub = `${config.project_subdir}-${Date.now().toString(36)}`;
  const agentWorkDir = `${AGENT_WORK_ROOT}/${sub}`;

  const prompt = [
    config.scenario.system_prompt,
    "",
    `Тема книги: ${subject}`,
    "",
    `Записывай каждую главу как файл chapter-<N>.md в каталоге проекта. В конце создай TOC.md со списком глав.`,
  ].join("\n");

  const created = await startConversation({
    workingDir: agentWorkDir,
    prompt,
    maxIterations: config.max_iterations ?? 50,
  });

  state.conversationId = created.id;
  state.status = "running";
  state.error = null;
  state.agentWorkDir = created.working_dir || agentWorkDir;
  state.hostWorkDir = agentToHostDir(state.agentWorkDir);
  return { ok: true, conversation_id: state.conversationId };
}

async function handleStatus() {
  if (!state.conversationId) return { status: state.status, conversation_id: null };
  try {
    const info = await getConversationStatus(state.conversationId);
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
  if (!state.hostWorkDir) return [];
  try {
    const files = (await readdir(state.hostWorkDir)).filter((f) => f.endsWith(".md")).sort();
    const out = [];
    for (const f of files) {
      const text = await readFile(path.join(state.hostWorkDir, f), "utf-8");
      out.push({ file: f, text });
    }
    return out;
  } catch {
    return [];
  }
}

async function buildSite() {
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
