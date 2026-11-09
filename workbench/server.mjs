import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const publicDir = path.join(here, "public");
const logsDir = path.join(root, "logs");
const runLogPath = path.join(logsDir, "workbench-run.log");
const liveLogPath = path.join(root, "live-terminal.log");
const materialPath = path.join(root, "data", "material-map.json");
const rulesPath = path.join(root, "data", "knowledge-rules.json");
const pendingPath = path.join(root, "data", "pending-erp-mark.json");
const PORT = Number(process.env.WORKBENCH_PORT || 8787);
const TOTAL_STEPS = 11;

fs.mkdirSync(logsDir, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const materials = readJson(materialPath, { materials: [] }).materials || [];
const rules = readJson(rulesPath, {});

// ============================== 事件总线 ==============================
const bus = new Set();
const lines = [];
const MAX_LINES = 800;
let jsonBuf = null;

const state = {
  running: false,
  startedAt: null,
  endedAt: null,
  exitCode: null,
  awaiting: null,
  step: null,
  steps: [],
  order: null,
  error: null
};

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of bus) {
    try {
      client.write(frame);
    } catch {
      bus.delete(client);
    }
  }
}

function publicState() {
  return {
    running: state.running,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    exitCode: state.exitCode,
    awaiting: state.awaiting,
    step: state.step,
    steps: state.steps.slice(-12),
    order: state.order,
    error: state.error,
    pendingMark: readJson(pendingPath, null),
    totalSteps: TOTAL_STEPS,
    materialsCount: materials.length,
    port: PORT
  };
}

function reclassify(text, t) {
  const stepMatch = text.match(/^>>>\s*\[Step\s+(\d+)\/(\d+)\s+([^\]]+)\]\s*(.*)$/);
  if (stepMatch) {
    state.step = { index: Number(stepMatch[1]), total: Number(stepMatch[2]), name: stepMatch[3].trim(), detail: stepMatch[4].trim() };
    state.steps.push({ ...state.step, t });
    if (state.steps.length > 40) state.steps.shift();
    state.error = null;
    broadcast({ type: "step", step: state.step });
    return;
  }
  if (/^本单未完成/.test(text)) {
    state.error = text;
    broadcast({ type: "error", text });
    return;
  }
  if (/^已暂停：/.test(text)) {
    state.error = text;
    broadcast({ type: "error", text });
    return;
  }
  if (/^本单已完成|^READY_FOR_NEXT_ORDER/.test(text)) {
    state.error = null;
    if (/^本单已完成/.test(text)) broadcast({ type: "done", text });
  }
}

function pushLine(text, stream) {
  const entry = { t: Date.now(), stream, text };
  lines.push(entry);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  broadcast({ type: "line", line: entry });
  reclassify(text, entry.t);
}

function handleLine(text, stream) {
  const trimmed = text.trim();
  if (jsonBuf) {
    jsonBuf.push(text);
    const isEnd = trimmed === "}";
    pushLine(text, stream);
    if (isEnd) {
      const raw = jsonBuf.join("\n");
      jsonBuf = null;
      try {
        const payload = JSON.parse(raw);
        if (payload && payload.parsed && payload.parsed.productCode) {
          state.order = payload;
          broadcast({ type: "order", order: payload });
        }
      } catch {
        /* 非订单 JSON，忽略 */
      }
    }
    return;
  }
  if (trimmed === "{") jsonBuf = [text];
  pushLine(text, stream);
}

// ============================== 子进程会话 ==============================
let child = null;
let buf = "";

function appendRunLog(text) {
  try {
    fs.appendFileSync(runLogPath, text, "utf8");
  } catch {
    /* 日志写失败不影响主流程 */
  }
}

function scanPrompt() {
  const tail = buf.slice(-500);
  if (/输入\s*Y\s*确认/.test(tail)) {
    if (!state.awaiting || state.awaiting.kind !== "confirm") {
      state.awaiting = { kind: "confirm", orderId: state.order?.orderId || null };
      broadcast({ type: "awaiting", awaiting: state.awaiting });
    }
    return;
  }
  if (/等待操作：/.test(tail)) {
    if (!state.awaiting || state.awaiting.kind !== "idle") {
      state.awaiting = { kind: "idle" };
      broadcast({ type: "awaiting", awaiting: state.awaiting });
    }
  }
}

function consume(chunk, stream) {
  appendRunLog(chunk);
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).replace(/\r$/, "");
    buf = buf.slice(idx + 1);
    handleLine(line, stream);
  }
  if (buf.length > 6000) buf = buf.slice(-6000);
  scanPrompt();
}

function startSession() {
  if (child) return { ok: false, reason: "会话已经在运行了" };
  fs.writeFileSync(runLogPath, `=== 工作台会话 ${new Date().toLocaleString()} ===\n`, "utf8");
  child = spawn(process.execPath, ["src/index.js"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" }
  });
  state.running = true;
  state.startedAt = Date.now();
  state.endedAt = null;
  state.exitCode = null;
  state.awaiting = null;
  state.step = null;
  state.steps = [];
  state.order = null;
  state.error = null;
  buf = "";
  jsonBuf = null;
  broadcast({ type: "reset" });
  broadcast({ type: "state", state: publicState() });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => consume(chunk, "out"));
  child.stderr.on("data", (chunk) => consume(chunk, "err"));
  child.on("error", (error) => {
    pushLine(`启动子进程失败：${error.message}`, "err");
  });
  child.on("exit", (code) => {
    state.running = false;
    state.exitCode = code;
    state.endedAt = Date.now();
    state.awaiting = null;
    child = null;
    appendRunLog(`\n=== 会话结束 exitCode=${code} ===\n`);
    pushLine(`=== 会话结束 exitCode=${code} ===`, "sys");
    broadcast({ type: "state", state: publicState() });
  });
  return { ok: true };
}

function stopSession() {
  if (!child) return { ok: false, reason: "会话未启动" };
  const target = child;
  try {
    target.stdin.write("close\n");
  } catch {
    /* 已退出 */
  }
  setTimeout(() => {
    try {
      target.kill();
    } catch {
      /* 已退出 */
    }
  }, 4000);
  pushLine("已发送关闭指令，等待浏览器释放...", "sys");
  return { ok: true };
}

function sendInput(text) {
  if (!child) return { ok: false, reason: "会话未启动，请先点「启动会话」" };
  try {
    child.stdin.write(`${text}\n`);
  } catch (error) {
    return { ok: false, reason: `写入失败：${error.message}` };
  }
  pushLine(`» 工作台下发：${text}`, "sys");
  state.awaiting = null;
  broadcast({ type: "awaiting", awaiting: null });
  return { ok: true };
}

function runOrder(orderId) {
  if (!child) return { ok: false, reason: "会话未启动，请先点「启动会话」" };
  const id = String(orderId || "").trim();
  if (id && !/^\d+$/.test(id)) return { ok: false, reason: "订单号只能是数字" };
  return sendInput(id ? `run ${id}` : "run");
}

// ============================== 查询 ==============================
function searchAll(rawQuery) {
  const query = String(rawQuery || "").trim();
  if (!query) return { query, materials: [], hood: [], tracks: [], mainPictures: [] };
  const low = query.toLowerCase();
  const hit = (value) => String(value ?? "").toLowerCase().includes(low);

  const matHits = [];
  for (const m of materials) {
    const variants = m.variants || [];
    const matchedVariants = variants.filter(
      (v) => hit(v.outputText) || hit(v.color) || hit(v.modelCode) || hit(v.finish)
    );
    const matched = (m.aliases || []).some(hit) || hit(m.searchText) || (m.candidateNames || []).some(hit) || matchedVariants.length > 0;
    if (!matched) continue;
    matHits.push({
      aliases: m.aliases || [],
      category: m.productCategory || "",
      text: m.searchText || "",
      status: m.status || "",
      variantCount: variants.length,
      variants: (matchedVariants.length ? matchedVariants : variants).slice(0, 20).map((v) => ({
        outputText: v.outputText || "",
        finish: v.finish || "",
        color: v.color || "",
        modelCode: v.modelCode || ""
      }))
    });
    if (matHits.length >= 60) break;
  }

  const hood = [];
  for (const [code, v] of Object.entries(rules.hoodRules || {})) {
    if (!(hit(code) || hit(v.category) || hit(v.fabricName) || hit(v.standardHood) || hit(v.deluxeHood))) continue;
    hood.push({ code, category: v.category || "", fabricName: v.fabricName || "", standardHood: v.standardHood || "", deluxeHood: v.deluxeHood || "" });
    if (hood.length >= 60) break;
  }

  const tracks = [];
  for (const [code, v] of Object.entries(rules.honeycombTrackRules || {})) {
    if (!(hit(code) || hit(JSON.stringify(v)))) continue;
    tracks.push({ code, deluxeTrack: v.deluxeTrack || "", cordlessTrack: v.cordlessTrack || "" });
    if (tracks.length >= 40) break;
  }

  const mainPictures = [];
  for (const [code, v] of Object.entries(rules.mainPictureModels || {})) {
    if (!(hit(code) || hit(JSON.stringify(v)))) continue;
    mainPictures.push({ code, modelCode: v.modelCode || "", fullDescription: v.fullDescription || "" });
  }

  return { query, materials: matHits, hood, tracks, mainPictures };
}

// ============================== HTTP ==============================
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const target = path.resolve(publicDir, rel);
  if (!target.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(target)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "state", state: publicState() })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "history", lines: lines.slice(-300) })}\n\n`);
    bus.add(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* 连接已断 */
      }
    }, 20000);
    req.on("close", () => {
      clearInterval(keepAlive);
      bus.delete(res);
    });
    return;
  }

  if (url.pathname === "/api/state") return sendJson(res, publicState());

  if (url.pathname === "/api/search") return sendJson(res, searchAll(url.searchParams.get("q")));

  if (url.pathname === "/api/logs") {
    const raw = fs.existsSync(liveLogPath) ? fs.readFileSync(liveLogPath, "utf8") : "";
    return sendJson(res, { text: raw.slice(-20000) });
  }

  if (req.method === "POST") {
    const body = await readBody(req);
    if (url.pathname === "/api/session/start") return sendJson(res, startSession());
    if (url.pathname === "/api/session/stop") return sendJson(res, stopSession());
    if (url.pathname === "/api/run") return sendJson(res, runOrder(body.orderId));
    if (url.pathname === "/api/answer") {
      const value = String(body.value || "").trim().toUpperCase();
      if (value !== "Y" && value !== "N") return sendJson(res, { ok: false, reason: "只接受 Y 或 N" }, 400);
      return sendJson(res, sendInput(value));
    }
    if (url.pathname === "/api/pending/clear") {
      try {
        fs.unlinkSync(pendingPath);
      } catch {
        /* 文件不存在 */
      }
      broadcast({ type: "state", state: publicState() });
      return sendJson(res, { ok: true });
    }
    return sendJson(res, { ok: false, reason: "未知接口" }, 404);
  }

  serveStatic(res, url.pathname);
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已被占用：工作台可能已经在运行，直接打开 http://localhost:${PORT} 即可。`);
  } else {
    console.error(`工作台启动失败: ${(err && err.message) || err}`);
  }
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(
      path.join(logsDir, "workbench-crash.log"),
      `\n=== ${new Date().toISOString()} [serverError] ===\n${(err && err.stack) || err}\n`,
      "utf8"
    );
  } catch {
    /* 日志写不进去也不能再抛 */
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`订单录入工作台已启动: http://localhost:${PORT}`);
  console.log(`物料库: ${materials.length} 条 | 工作目录: ${root}`);
  if (process.argv.includes("--open")) {
    setTimeout(() => {
      const comspec = process.env.ComSpec || "cmd.exe";
      try {
        const p = spawn(comspec, ["/c", "start", "", `http://localhost:${PORT}`], {
          detached: true,
          stdio: "ignore"
        });
        p.on("error", () => {
          console.log(`[提示] 未能自动打开浏览器，请手动访问 http://localhost:${PORT}`);
        });
        p.unref();
      } catch {
        console.log(`[提示] 未能自动打开浏览器，请手动访问 http://localhost:${PORT}`);
      }
    }, 700);
  }
});

function shutdown() {
  if (child) {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ============================== 崩溃留痕 ==============================
// 双击 .cmd 时窗口可能一闪就没，这里保证任何异常都落到 logs/workbench-crash.log
function crashLog(kind, err) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const body = err && err.stack ? err.stack : String(err);
    fs.appendFileSync(
      path.join(logsDir, "workbench-crash.log"),
      `\n=== ${new Date().toISOString()} [${kind}] ===\n${body}\n`,
      "utf8"
    );
  } catch {
    /* 忽略 */
  }
  console.error(`[工作台异常] ${kind}: ${(err && err.message) || err}`);
}

process.on("uncaughtException", (err) => crashLog("uncaughtException", err));
process.on("unhandledRejection", (err) => crashLog("unhandledRejection", err));
