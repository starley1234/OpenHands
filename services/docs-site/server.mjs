#!/usr/bin/env node
/**
 * Прослойка-сервис «docs-site»: генерирует сайт документации по папке.
 *
 * Пользователь указывает путь к репозиторию/папке на хосте. Сервис:
 *  1. монтирует эту папку как рабочую директорию агента (через маппинг
 *     HOST_WORK_ROOT ↔ AGENT_WORK_ROOT);
 *  2. создаёт диалог на едином бэкенде со сценарием «задокументируй»;
 *  3. агент пишет docs/<NN>-<slug>.md прямо в указанную папку (и в docs/);
 *  4. прослойка собирает статический сайт документации в out/ и отдаёт его.
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
const config = JSON.parse(await readFile(path.join(__dirname, "config.json"), "utf-8"));

const AGENT_WORK_ROOT = (process.env.AGENT_WORK_ROOT || "/projects").replace(/\/+$/, "");
const HOST_WORK_ROOT = (
  process.env.HOST_WORK_ROOT || path.resolve(__dirname, "..", "..", "projects")
).replace(/\/+$/, "");

function agentToHostDir(agentDir) {
  if (!agentDir) return null;
  if (agentDir.startsWith(AGENT_WORK_ROOT)) {
    return path.join(HOST_WORK_ROOT, agentDir.slice(AGENT_WORK_ROOT.length).replace(/^\/+/, ""));
  }
  return agentDir;
}

const state = { conversationId: null, status: "idle", error: null, agentWorkDir: null, hostWorkDir: null };

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".md": "text/plain; charset=utf-8", ".json": "application/json", ".png": "image/png",
};

async function serveStatic(res, baseDir, urlPath) {
  const target = path.normalize(path.join(baseDir, decodeURIComponent(urlPath)));
  if (!target.startsWith(path.resolve(baseDir))) return res.writeHead(403).end("Forbidden");
  const p = existsSync(target) && (await stat(target)).isDirectory() ? path.join(target, "index.html") : target;
  try {
    const data = await readFile(p);
    res.writeHead(200, { "Content-Type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404).end("Not found"); }
}

async function handleRun(body) {
  const hostRepoPath = (body && body.repo_path || "").trim();
  if (!hostRepoPath) return { ok: false, error: "repo_path is required (host path to the repo to document)" };

  // Маппинг host-пути репо -> путь, который видит агент внутри контейнера.
  // Если репо лежит внутри HOST_WORK_ROOT, пересчитываем в AGENT_WORK_ROOT;
  // иначе пробуем как есть.
  let agentRepoPath = hostRepoPath;
  if (path.resolve(hostRepoPath).startsWith(path.resolve(HOST_WORK_ROOT))) {
    const rel = path.relative(HOST_WORK_ROOT, path.resolve(hostRepoPath));
    agentRepoPath = `${AGENT_WORK_ROOT}/${rel}`;
  }

  // Уникальная рабочая директория агента для собранного сайта.
  const sub = `${config.project_subdir}-${Date.now().toString(36)}`;
  const agentWorkDir = `${AGENT_WORK_ROOT}/${sub}`;

  const prompt = [
    config.scenario.system_prompt,
    "",
    `Редактируемый репозиторий: ${agentRepoPath}`,
    "",
    `Рабочая директория (куда писать docs/): ${agentWorkDir}`,
    "",
    `Прочитай код в ${agentRepoPath} и напиши документацию в docs/ внутри рабочей директории ${agentWorkDir}.`,
  ].join("\n");

  const created = await startConversation({ workingDir: agentWorkDir, prompt, maxIterations: config.max_iterations ?? 25 });

  state.conversationId = created.id;
  state.status = "running";
  state.error = null;
  state.agentWorkDir = created.working_dir || agentWorkDir;
  state.hostWorkDir = agentToHostDir(state.agentWorkDir);
  return { ok: true, conversation_id: state.conversationId, repo_path: agentRepoPath };
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

async function readDocs() {
  if (!state.hostWorkDir) return [];
  const dir = path.join(state.hostWorkDir, "docs");
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
    const out = [];
    for (const f of files) {
      out.push({ file: f, text: await readFile(path.join(dir, f), "utf-8") });
    }
    return out;
  } catch { return []; }
}

async function buildSite() {
  const outDir = path.join(__dirname, "out");
  await mkdir(outDir, { recursive: true });
  const docs = await readDocs();
  const nav = docs.map((d) => `<li><a href="#${slug(d.file)}">${escapeHtml(d.file)}</a></li>`).join("\n");
  const body = docs.map((d) => `<section id="${slug(d.file)}"><h2>${escapeHtml(d.file)}</h2><pre class="doc">${escapeHtml(d.text)}</pre></section>`).join("\n");
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Документация</title>
<style>body{font-family:sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;line-height:1.6}
pre.doc{white-space:pre-wrap;background:#f6f7f9;padding:1rem;border-radius:8px}nav a{color:#06c}</style>
</head><body><h1>Документация</h1><nav><ul>${nav}</ul></nav>${body}</body></html>`;
  await writeFile(path.join(outDir, "index.html"), html, "utf-8");
}

function slug(s) { return String(s).replace(/[^a-z0-9]/gi, "-").toLowerCase(); }
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/health") return res.writeHead(200).end("ok");
    if (url.pathname === "/api/run" && req.method === "POST") {
      const body = JSON.parse(await readRequestBody(req) || "{}");
      const result = await handleRun(body);
      return res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    }
    if (url.pathname === "/api/status") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(await handleStatus()));
    if (url.pathname === "/api/result") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(await handleResult()));
    if (url.pathname.startsWith("/out/")) return serveStatic(res, path.join(__dirname, "out"), url.pathname.replace(/^\/out/, ""));
    return serveStatic(res, path.join(__dirname, "web"), url.pathname === "/" ? "/index.html" : url.pathname);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(err) }));
  }
});

async function handleResult() {
  const docs = await readDocs();
  return { ok: true, sections: docs.map((d) => d.file), site_url: `http://localhost:${config.port}/out/index.html` };
}

function readRequestBody(req) {
  return new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); });
}

server.listen(config.port, "0.0.0.0", () => {
  console.log(`[docs-site] listening on http://0.0.0.0:${config.port}`);
});
