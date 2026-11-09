import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { buildDetailRows, detectDoNotCopyInstruction, parseAmount, parseOrderText, resolveMaterialText } from "./parser.js";
import { recordDualDecision, extractSpecFragment } from "./ai-dual.js";
import { matchSelectionCatalogFromText } from "./catalog-match.js";
import { buildOrderLinePlans, linePlanBlockers } from "./order-line-plans.js";
import { AuditStore } from "./audit-store.js";
import { BatchQueue, createBatchId } from "./batch-queue.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "unknown";
const auditStore = new AuditStore(path.join(root, "data", "audit", "order-automation.db"), { version: packageVersion });
const selectionCatalogPath = path.join(root, "data", "selection-catalog.index.json");
const selectionCatalog = fs.existsSync(selectionCatalogPath)
  ? JSON.parse(fs.readFileSync(selectionCatalogPath, "utf8")).records || []
  : [];
const liveLogPath = path.join(root, "live-terminal.log");
fs.writeFileSync(liveLogPath, `=== 订单自动化调试日志 ${new Date().toLocaleString()} ===\n`, "utf8");
const originalConsoleLog = console.log;
console.log = (...args) => {
  originalConsoleLog(...args);
  try {
    fs.appendFileSync(
      liveLogPath,
      args.map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" ") + "\n",
      "utf8"
    );
  } catch { }
};
const logsDir = path.join(root, "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const auditLogPath = path.join(logsDir, "test-execution-audit.log");

function logStep(stepIndex, totalSteps, actionName, details = "") {
  const prefix = `>>> [Step ${stepIndex}/${totalSteps} ${actionName}]`;
  if (currentAuditContext) auditStore.event({ ...currentAuditContext, step: `step-${stepIndex}-${actionName}`, phase: "success", payload: { details } });
  const message = details ? `${prefix} ${details}` : prefix;
  console.log(message);
  try {
    fs.appendFileSync(
      auditLogPath,
      `[${new Date().toISOString()}] [Step ${stepIndex}/${totalSteps}] [${actionName}] ${details}\n`,
      "utf8"
    );
  } catch { }
}

const WORKFLOW_ORDER = [1, 2, 9, 10, 3, 4, 5, 6, 7, 8, 11];

function isMultiPieceOrder(parsed) {
  const quantity = Number(parsed?.quantity || 1);
  const pairs = parsed?.dimensionPairs || [];
  const groups = parsed?.detailGroups || [];
  if (groups.length >= 1) {
    const groupTotal = groups.reduce((sum, group) => sum + Number(group.quantity || 0), 0);
    const groupsComplete = groups.every((group) => group.width > 0 && group.height > 0 && group.quantity > 0
      && (group.quantity === 1 || group.sides?.length === group.quantity));
    if (groupsComplete && groupTotal === quantity) return false;
  }
  // 允许同一物料明确列出多组完整宽高（A/B、1/2 等），每组生成一条明细。
  if (pairs.length > 1 && quantity === pairs.length && pairs.every((pair) => pair.width > 0 && pair.height > 0)) return false;
  // 允许同一尺寸、同一拉珠方向的多件订单，一条明细直接填写件数。
  const nonEmptySides = [...new Set((parsed?.sides || []).filter(Boolean))];
  if (quantity > 1 && parsed?.width > 0 && parsed?.height > 0 && pairs.length <= 1 && nonEmptySides.length <= 1) return false;
  return quantity > 1
    || pairs.length > 1
    || (parsed?.sides?.includes("左拉珠") && parsed?.sides?.includes("右拉珠"));
}

function formatOrderSizes(parsed) {
  const groups = parsed?.detailGroups || [];
  if (groups.length > 1) return groups.map((group, index) => `${index + 1}. ${group.width}m × ${group.height}m × ${group.quantity}件`).join("；");
  const pairs = parsed?.dimensionPairs || [];
  if (pairs.length > 1) return pairs.map((pair, index) => `${index + 1}. ${pair.width}m × ${pair.height}m`).join("；");
  return `${parsed?.width ?? "?"}m × ${parsed?.height ?? "?"}m`;
}

function processedOrderBlockers(text) {
  const value = String(text || "");
  const blockers = [];
  if (detectDoNotCopyInstruction(value)) blockers.push("卖家备注含暂不抄/禁止抄指令，禁止自动抄单");
  if (/已抄/.test(value)) blockers.push("卖家备注已含“已抄”，禁止重复抄单");
  if (/发货中|已审核|配货中|已发货/.test(value)) blockers.push("订单已进入发货流程，禁止重复抄单");
  return blockers;
}

async function confirmWorkflowStep(page, stepNumber, actionName, details = "") {
  const sequence = WORKFLOW_ORDER.indexOf(stepNumber) + 1;
  if (!page || sequence <= 0) throw new Error(`未知人工确认步骤：${stepNumber}`);
  if (currentAuditContext) auditStore.event({ ...currentAuditContext, step: `step-${stepNumber}-${actionName}`, phase: "authorized", executor: "user_confirm", payload: { sequence, details } });
  if (config.confirmEveryStep === false) {
    console.log(`[连续执行 ${sequence}/11] 步骤 ${stepNumber} ${actionName}：已由订单总确认授权，自动继续`);
    return;
  }
  await page.bringToFront().catch(() => { });
  const accepted = await page.evaluate(({ stepNumber, sequence, actionName, details }) => new Promise((resolve) => {
    document.getElementById("codex-step-confirm")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "codex-step-confirm";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.48);display:flex;align-items:center;justify-content:center;font-family:Microsoft YaHei,sans-serif";
    const card = document.createElement("div");
    card.style.cssText = "width:580px;max-width:90vw;background:#fff;border-radius:12px;padding:26px;box-shadow:0 18px 55px rgba(0,0,0,.35);color:#222;font-size:15px;line-height:1.7";
    const safe = (value) => String(value ?? "").replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;" }[c]));
    card.innerHTML = `<div style="font-size:21px;font-weight:700;margin-bottom:10px">执行步骤 ${stepNumber}：${safe(actionName)}</div>
      <div style="color:#666;margin-bottom:12px">当前流程第 ${sequence}/11 步（顺序：1 → 2 → 9 → 10 → 3 → 4 → 5 → 6 → 7 → 8 → 11）</div>
      <div style="padding:12px;background:#f6f8fa;border-radius:6px;white-space:pre-wrap">${safe(details)}</div>
      <div style="color:#c62828;margin-top:12px">点击“确认执行”后，本步骤才会开始。</div>
      <div style="display:flex;justify-content:flex-end;gap:12px;margin-top:20px">
        <button id="codex-step-stop" style="padding:9px 22px">停止本单</button>
        <button id="codex-step-go" style="padding:9px 22px;background:#1677ff;color:#fff;border:0;border-radius:5px">确认执行</button>
      </div>`;
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const stopButton = card.querySelector("#codex-step-stop");
    const goButton = card.querySelector("#codex-step-go");
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.repeat) return;
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
    };
    stopButton.onclick = () => finish(false);
    goButton.onclick = () => finish(true);
    document.addEventListener("keydown", onKey, true);
    goButton.focus();
  }), { stepNumber, sequence, actionName, details });
  if (!accepted) throw new Error(`用户在步骤 ${stepNumber}（${actionName}）前停止本单`);
}

async function requestHumanTakeover(page, actionName, errorMessage) {
  await page.bringToFront().catch(() => { });
  const continued = await page.evaluate(({ actionName, errorMessage }) => new Promise((resolve) => {
    document.getElementById("codex-human-takeover")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "codex-human-takeover";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.52);display:flex;align-items:center;justify-content:center;font-family:Microsoft YaHei,sans-serif";
    const card = document.createElement("div");
    card.style.cssText = "width:620px;max-width:92vw;background:#fff;border-radius:12px;padding:26px;box-shadow:0 18px 55px rgba(0,0,0,.4);color:#222;font-size:15px;line-height:1.7";
    const safe = (value) => String(value ?? "").replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;" }[c]));
    card.innerHTML = `<div style="font-size:22px;font-weight:700;color:#c62828;margin-bottom:10px">需要人工接管：${safe(actionName)}</div>
      <div style="padding:12px;background:#fff3f3;border:1px solid #ffcdd2;border-radius:6px;white-space:pre-wrap">${safe(errorMessage)}</div>
      <div style="margin-top:14px">请在当前页面人工完成这一操作并核对结果。完成后点击“人工已完成，继续自动流程”。</div>
      <div style="color:#c62828;margin-top:8px">未完成或不确定时必须停止本单，不能继续。</div>
      <div style="display:flex;justify-content:flex-end;gap:12px;margin-top:20px">
        <button id="codex-takeover-stop" style="padding:9px 22px">停止本单</button>
        <button id="codex-takeover-go" style="padding:9px 22px;background:#1677ff;color:#fff;border:0;border-radius:5px">人工已完成，继续自动流程</button>
      </div>`;
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const stopButton = card.querySelector("#codex-takeover-stop");
    const goButton = card.querySelector("#codex-takeover-go");
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.repeat) return;
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
    };
    stopButton.onclick = () => finish(false);
    goButton.onclick = () => finish(true);
    document.addEventListener("keydown", onKey, true);
    goButton.focus();
  }), { actionName, errorMessage });
  if (!continued) throw new Error(`人工接管步骤“${actionName}”未完成，已停止本单`);
  console.log(`[人工接管] ${actionName} 已由人工确认完成，继续后续流程`);
}

async function withHumanTakeover(page, actionName, action, afterHuman = null) {
  try {
    return await action();
  } catch (error) {
    console.error(`[自动步骤失败] ${actionName}：${error.message}`);
    if (currentAuditContext) auditStore.event({ ...currentAuditContext, step: actionName, phase: "automation_failed", error: error.message });
    await requestHumanTakeover(page, actionName, error.message);
    if (currentAuditContext) auditStore.event({ ...currentAuditContext, step: actionName, phase: "human_completed", executor: "human_takeover" });
    return afterHuman ? await afterHuman() : undefined;
  }
}

async function showCompletionNotice(page, { orderId, voucher, detailCount }) {
  await page.bringToFront().catch(() => { });
  await page.evaluate(({ orderId, voucher, detailCount }) => {
    document.getElementById("codex-completion-notice")?.remove();
    const notice = document.createElement("div");
    notice.id = "codex-completion-notice";
    notice.style.cssText = "position:fixed;right:28px;top:28px;z-index:2147483647;width:390px;max-width:calc(100vw - 56px);background:#f0fff4;border:2px solid #22a447;border-radius:12px;padding:20px 22px;box-shadow:0 14px 40px rgba(0,0,0,.28);font-family:Microsoft YaHei,sans-serif;color:#173b22;line-height:1.7";
    notice.innerHTML = `<div style="font-size:23px;font-weight:700;color:#16803c">✓ 抄单完成</div>
      <div style="margin-top:8px"><b>订单号：</b>${String(orderId)}</div>
      <div><b>报价凭证：</b>${String(voucher || "已保存")}</div>
      <div><b>明细：</b>${Number(detailCount || 0)} 条</div>
      <div style="margin-top:8px;color:#52705a;font-size:13px">10秒后自动关闭；按 Enter 可立即关闭。</div>`;
    document.body.appendChild(notice);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      notice.remove();
    };
    const onKey = (event) => {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    notice.onclick = close;
    document.addEventListener("keydown", onKey, true);
    setTimeout(close, 10000);
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const audio = new AudioContextClass();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.08, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.28);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start();
      oscillator.stop(audio.currentTime + 0.28);
    } catch { }
  }, { orderId, voucher, detailCount });
}

const configPath = path.join(root, "config.json");
if (!fs.existsSync(configPath)) fs.copyFileSync(path.join(root, "config.example.json"), configPath);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const mappings = JSON.parse(fs.readFileSync(path.join(root, "data", "material-map.json"), "utf8"));
const pendingMarkPath = path.join(root, "data", "pending-erp-mark.json");
const input = readline.createInterface({ input: process.stdin, output: process.stdout });
let context;
let lastClickedOrder = null;
const browserCommandQueue = [];
const browserConfirmedOrders = new Set();
const preparedOrderSnapshots = new Map();
const browserConfirmStartedAt = new Map();
let browserCommandResolver = null;
let browserCommandPromise = null;
let pendingTerminalQuestion = null;
let checkedOrderMonitorBusy = false;
let lastCheckedOrderSignature = "";
let checkedOrderMonitorArmed = false;
const savedVoucherOrders = new Map();
const batchStatePath = path.join(root, "data", "audit", "active-batch.json");
let activeBatchQueue = null;
let currentAuditContext = null;
let lastCheckedOrderChangedAt = 0;

function enqueueBrowserCommand(command) {
  if (browserCommandResolver) {
    const resolve = browserCommandResolver;
    browserCommandResolver = null;
    browserCommandPromise = null;
    resolve(command);
  } else browserCommandQueue.push(command);
}

function waitForBrowserCommand() {
  if (browserCommandQueue.length) return Promise.resolve(browserCommandQueue.shift());
  if (!browserCommandPromise) browserCommandPromise = new Promise((resolve) => { browserCommandResolver = resolve; });
  return browserCommandPromise;
}

async function waitForOperation() {
  if (!pendingTerminalQuestion) pendingTerminalQuestion = input.question("等待操作：");
  const result = await Promise.race([
    pendingTerminalQuestion.then((value) => ({ source: "terminal", value })),
    waitForBrowserCommand().then((value) => ({ source: "browser", value }))
  ]);
  if (result.source === "terminal") pendingTerminalQuestion = null;
  return String(result.value || "").trim();
}

function installOrderClickListener() {
  const listenerVersion = 6;
  if (window.__codexOrderClickVersion === listenerVersion) return;
  window.__codexOrderClickVersion = listenerVersion;
  window.__codexOrderClickInstalled = true;
  window.__codexBatchCollectionMode = false;
  window.__codexUpdateBatchTray = () => {
    const toggle = document.getElementById("codex-batch-mode-toggle");
    if (toggle) {
      toggle.textContent = window.__codexBatchCollectionMode ? "连续抄单：已开启" : "连续抄单：关闭";
      toggle.style.background = window.__codexBatchCollectionMode ? "#16803c" : "#555";
    }
    document.getElementById("codex-batch-tray")?.remove();
    if (!window.__codexBatchCollectionMode || !document.body) return;
    const checked = [...document.querySelectorAll("input._jt_cbx:checked")].filter((node) => !node.closest("thead, th"));
    const tray = document.createElement("div"); tray.id = "codex-batch-tray";
    tray.style.cssText = "position:fixed;right:24px;bottom:72px;z-index:2147483645;width:300px;background:#fff;border:2px solid #16803c;border-radius:10px;padding:14px;box-shadow:0 10px 30px rgba(0,0,0,.25);font-family:Microsoft YaHei,sans-serif";
    tray.innerHTML = `<div style="font-size:17px;font-weight:700">连续抄单选单中</div><div style="margin:8px 0">已选择 <b>${checked.length}</b> 笔订单</div><div style="display:flex;justify-content:flex-end;gap:8px"><button id="codex-batch-clear">清空</button><button id="codex-batch-preview" ${checked.length >= 2 ? "" : "disabled"} style="background:#1677ff;color:#fff;border:0;border-radius:4px;padding:7px 14px;opacity:${checked.length >= 2 ? 1 : .45}">开始预检</button></div>`;
    document.body.appendChild(tray);
    tray.querySelector("#codex-batch-clear").onclick = () => {
      window.__codexBatchSelecting = true;
      checked.forEach((node) => { node.checked = false; node.dispatchEvent(new Event("change", { bubbles: true })); });
      window.__codexBatchSelecting = false;
      window.__codexUpdateBatchTray();
    };
    tray.querySelector("#codex-batch-preview").onclick = () => window.__codexShowBatchConfirm?.();
  };
  const mountBatchToggle = () => {
    if (!document.body || document.getElementById("codex-batch-mode-toggle")) return;
    const toggle = document.createElement("button"); toggle.id = "codex-batch-mode-toggle";
    toggle.style.cssText = "position:fixed;right:24px;bottom:24px;z-index:2147483645;padding:10px 16px;background:#555;color:#fff;border:0;border-radius:7px;box-shadow:0 8px 22px rgba(0,0,0,.24);font-family:Microsoft YaHei,sans-serif;font-weight:700";
    toggle.onclick = () => {
      window.__codexBatchCollectionMode = !window.__codexBatchCollectionMode;
      document.getElementById("codex-order-confirm")?.remove();
      document.getElementById("codex-batch-confirm")?.remove();
      window.__codexUpdateBatchTray();
    };
    document.body.appendChild(toggle);
    window.__codexUpdateBatchTray();
  };
  if (document.body) mountBatchToggle(); else document.addEventListener("DOMContentLoaded", mountBatchToggle, { once: true });
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    let row = target.closest("._jt_row, tr, [role='row']");
    if (!row) {
      let current = target;
      while (current && current !== document.body) {
        const height = current.getBoundingClientRect().height;
        if (height >= 18 && height <= 300 && /\b\d{7}\b/.test(current.innerText || "")) row = current;
        if (height > 300) break;
        current = current.parentElement;
      }
    }
    if (!row) return;
    const preferred = row.querySelector('[data-id="so_id"], [data-id="o_id"], [data-id="order_id"], [data-id="orderId"]');
    const text = `${preferred?.textContent || ""} ${row.innerText || ""}`;
    const orderId = text.match(/\b\d{7}\b/)?.[0];
    if (!orderId || typeof window.__codexRememberOrderClick !== "function") return;
    document.querySelectorAll('[data-codex-current-order="true"]').forEach((node) => {
      node.removeAttribute("data-codex-current-order");
      node.style.removeProperty("box-shadow");
    });
    row.setAttribute("data-codex-current-order", "true");
    row.style.setProperty("box-shadow", "inset 4px 0 #ff7a00", "important");
    window.__codexRememberOrderClick(orderId);
  }, true);

  window.__codexShowCheckedOrderConfirm = async (checkbox) => {
    if (window.__codexBatchSelecting) return;
    if (!checkbox || !checkbox.checked) return;
    if (checkbox.closest("thead, th, .el-table__header, .ant-table-header")) return;
    const row = checkbox.closest("._jt_row, tr, [role='row']");
    if (!row || typeof window.__codexPrepareCheckedOrder !== "function") return;
    const rowText = (row.innerText || "").trim();
    const orderId = rowText.match(/\b\d{7}\b/)?.[0];
    if (!orderId) return;
    const sellerMemoCell = row.querySelector('._jt_cell[data-id="remark"]');
    const sellerMemo = sellerMemoCell?.getAttribute("title") ?? null;
    const visibleRows = [...document.querySelectorAll("._jt_row, tr, [role='row']")].filter((node) => /\b\d{7}\b/.test(node.innerText || ""));
    const visibleIndex = rowText.match(/^\s*(\d{1,4})\s+/)?.[1] || Math.max(1, visibleRows.indexOf(row) + 1);
    const checked = [...document.querySelectorAll('input[type="checkbox"]:checked')].filter((node) => {
      if (node.closest("thead, th")) return false;
      const checkedRow = node.closest("._jt_row, tr, [role='row']");
      return Boolean(checkedRow && /\b\d{7}\b/.test(checkedRow.innerText || ""));
    });
    if (checked.length > 1) {
      console.warn(`[抄单助手] 当前勾选 ${checked.length} 笔，必须只保留一笔。`);
      return;
    }
    const info = await window.__codexPrepareCheckedOrder({ orderId, rowText, visibleIndex, sellerMemo });
    document.getElementById("codex-order-confirm")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "codex-order-confirm";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-family:Microsoft YaHei,sans-serif";
    const card = document.createElement("div");
    card.style.cssText = "width:560px;max-width:90vw;background:#fff;border-radius:12px;padding:24px;box-shadow:0 16px 50px rgba(0,0,0,.3);color:#222;font-size:15px;line-height:1.8";
    const safe = (value) => String(value ?? "").replace(/[&<>\"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
    card.innerHTML = `<div style="font-size:20px;font-weight:700;margin-bottom:12px">是否抄单？</div>
      <div><b>页面序号：</b>${safe(info.sequence)}</div><div><b>内部订单号：</b>${safe(info.orderId)}</div>
      <div><b>成交金额：</b>${safe(info.amount ? `¥${info.amount}` : "未识别")}</div>
      <div><b>商品参数：</b>${safe(info.product)}</div><div><b>制作尺寸：</b>${safe(info.size)}</div>
      <div><b>拉珠方向：</b>${safe(info.pullDirection)}</div><div><b>报价单备注：</b>${safe(info.quoteRemark)}</div>
      <div><b>权威目录：</b>${safe(info.catalog)}</div><div><b>选品搜索词：</b>${safe(info.selection)}</div>
      <div style="margin-top:10px;color:${info.ready ? "#16803c" : "#c62828"}"><b>${safe(info.status)}</b></div>
      ${info.ready ? '<div style="margin-top:6px;color:#555">确认后将连续执行全部步骤；遇到异常会自动暂停并请求人工接管。</div>' : ''}
      <div style="display:flex;justify-content:flex-end;gap:12px;margin-top:18px"><button id="codex-cancel" style="padding:8px 22px">取消</button><button id="codex-confirm" ${info.ready ? "" : "disabled"} style="padding:8px 22px;background:#1677ff;color:white;border:0;border-radius:5px;opacity:${info.ready ? "1" : ".45"}">确认抄单</button></div>`;
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const cancelButton = card.querySelector("#codex-cancel");
    const confirmButton = card.querySelector("#codex-confirm");
    let settled = false;
    const cleanup = () => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      checkbox.checked = false;
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const confirm = async () => {
      if (settled || !info.ready) return;
      settled = true;
      confirmButton.disabled = true;
      cleanup();
      await window.__codexConfirmCheckedOrder(info.orderId);
    };
    const onKey = (event) => {
      if (event.repeat) return;
      if (event.key === "Enter" && info.ready) { event.preventDefault(); event.stopPropagation(); confirm(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    cancelButton.onclick = cancel;
    confirmButton.onclick = confirm;
    document.addEventListener("keydown", onKey, true);
    (info.ready ? confirmButton : cancelButton).focus();
  };

  window.__codexShowBatchConfirm = async () => {
    if (window.__codexBatchSelecting || typeof window.__codexPrepareCheckedOrder !== "function") return;
    const checkboxes = [...document.querySelectorAll("input._jt_cbx:checked")].filter((node) => !node.closest("thead, th"));
    if (checkboxes.length < 2) return;
    const infos = [];
    for (const checkbox of checkboxes) {
      const row = checkbox.closest("._jt_row, tr, [role='row']");
      const rowText = (row?.innerText || "").trim();
      const orderId = rowText.match(/\b\d{7}\b/)?.[0];
      if (!orderId) continue;
      const sellerMemo = row.querySelector('._jt_cell[data-id="remark"]')?.getAttribute("title") ?? null;
      const visibleRows = [...document.querySelectorAll("._jt_row, tr, [role='row']")].filter((node) => /\b\d{7}\b/.test(node.innerText || ""));
      const visibleIndex = rowText.match(/^\s*(\d{1,4})\s+/)?.[1] || Math.max(1, visibleRows.indexOf(row) + 1);
      infos.push(await window.__codexPrepareCheckedOrder({ orderId, rowText, visibleIndex, sellerMemo }));
    }
    infos.sort((a, b) => Number(a.sequence || 999999) - Number(b.sequence || 999999));
    if (infos.length < 2) return;
    document.getElementById("codex-order-confirm")?.remove();
    document.getElementById("codex-batch-confirm")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "codex-batch-confirm";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-family:Microsoft YaHei,sans-serif";
    const card = document.createElement("div");
    card.style.cssText = "width:900px;max-width:94vw;max-height:86vh;overflow:auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 18px 55px rgba(0,0,0,.4);color:#222;font-size:14px";
    const safe = (value) => String(value ?? "").replace(/[&<>\"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[c]));
    const allReady = infos.every((info) => info.ready);
    const rows = infos.map((info, index) => `<tr><td>${index + 1}</td><td>${safe(info.sequence)}</td><td>${safe(info.orderId)}</td><td>${safe(info.product)}</td><td>${safe(info.size)}</td><td style="color:${info.ready ? "#16803c" : "#c62828"}">${safe(info.status)}</td></tr>`).join("");
    card.innerHTML = `<div style="font-size:22px;font-weight:700">连续抄单预检：${infos.length}笔</div>
      <div style="margin:8px 0 14px;color:#555">执行顺序按页面序号排列。开始后聚水潭始终只勾选当前正在处理的一单。</div>
      <table style="width:100%;border-collapse:collapse"><thead><tr><th>#</th><th>页面序号</th><th>订单号</th><th>商品</th><th>尺寸</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table>
      <div style="margin-top:14px;color:${allReady ? "#16803c" : "#c62828"};font-weight:700">${allReady ? "全部预检通过，可以连续抄单" : "存在不可抄订单，请取消后重新选择"}</div>
      <div style="display:flex;justify-content:flex-end;gap:12px;margin-top:18px"><button id="codex-batch-cancel" style="padding:9px 22px">取消</button><button id="codex-batch-go" ${allReady ? "" : "disabled"} style="padding:9px 22px;background:#1677ff;color:white;border:0;border-radius:5px;opacity:${allReady ? 1 : .45}">开始连续抄单</button></div>`;
    card.querySelectorAll("th,td").forEach((cell) => cell.style.cssText += ";border:1px solid #ddd;padding:7px;text-align:left;vertical-align:top");
    overlay.appendChild(card); document.body.appendChild(overlay);
    card.querySelector("#codex-batch-cancel").onclick = () => overlay.remove();
    card.querySelector("#codex-batch-go").onclick = async () => {
      if (!allReady) return;
      const button = card.querySelector("#codex-batch-go"); button.disabled = true;
      window.__codexBatchSelecting = true;
      for (const checkbox of checkboxes) { checkbox.checked = false; checkbox.dispatchEvent(new Event("change", { bubbles: true })); }
      window.__codexBatchSelecting = false;
      window.__codexBatchCollectionMode = false;
      window.__codexUpdateBatchTray?.();
      overlay.remove();
      await window.__codexConfirmBatch(infos);
    };
  };

  let codexSelectionTimer = null;
  document.addEventListener("change", (event) => {
    const checkbox = event.target instanceof HTMLInputElement && event.target.type === "checkbox" ? event.target : null;
    if (!checkbox || window.__codexBatchSelecting) return;
    if (window.__codexBatchCollectionMode) { window.__codexUpdateBatchTray(); return; }
    clearTimeout(codexSelectionTimer);
    codexSelectionTimer = setTimeout(() => {
      const checked = [...document.querySelectorAll("input._jt_cbx:checked")].filter((node) => !node.closest("thead, th"));
      if (checked.length > 1) window.__codexShowBatchConfirm();
      else if (checked.length === 1) window.__codexShowCheckedOrderConfirm(checked[0]);
    }, 900);
  }, true);
}

async function setupOrderClickTracking(browserContext) {
  await browserContext.exposeBinding("__codexRememberOrderClick", (source, orderId) => {
    if (!/^\d{7}$/.test(String(orderId || ""))) return;
    const changed = lastClickedOrder?.orderId !== String(orderId);
    lastClickedOrder = { orderId: String(orderId), timestamp: Date.now(), url: source.frame.url() };
    if (changed) console.log(`[人机共存] 已记住你最后点击的订单：${orderId}。现在可直接输入 try 或 run。`);
  });
  await browserContext.exposeBinding("__codexPrepareCheckedOrder", (source, payload) => {
    const orderId = String(payload?.orderId || "");
    const cached = getCachedOrder(orderId);
    const text = cached?.combinedText || String(payload?.rowText || "");
    const parsed = parseOrderText(text);
    const amount = parseAmount(text);
    const pendingResume = fs.existsSync(pendingMarkPath) ? JSON.parse(fs.readFileSync(pendingMarkPath, "utf8")) : null;
    const hasPendingResume = pendingResume?.orderId === orderId && !pendingResume?.quoteSuccess;
    const linePlans = buildOrderLinePlans(text, selectionCatalog, mappings.materials);
    const catalogMatch = linePlans[0]?.catalogMatch || { status: "none" };
    const detailRows = linePlans.flatMap((plan) => plan.rows);
    const sideLabel = (side) => parsed.productCode === "5002"
      ? (side === "左拉珠" ? "左单拉" : side === "右拉珠" ? "右单拉" : "双拉珠（默认）")
      : (side === "左拉珠" ? "左拉" : "右拉（默认）");
    const pullDirection = detailRows.length > 1
      ? detailRows.map((row, index) => `${index + 1}. ${row.width}m×${row.height}m：${sideLabel(row.side)}`).join("；")
      : sideLabel(parsed.sides?.[0] || "");
    const quoteRemark = detailRows.length > 1
      ? detailRows.map((row, index) => `${index + 1}. ${row.width}m×${row.height}m：${row.remark || "空（默认右拉）"}`).join("；")
      : (detailRows[0]?.remark || "");
    const authoritativeSellerMemo = cached
      ? String(cached.sellerMemo ?? "")
      : (typeof payload?.sellerMemo === "string" ? payload.sellerMemo : null);
    const processedBlockers = hasPendingResume
      ? []
      : [...processedOrderBlockers(text), ...processedOrderBlockers(authoritativeSellerMemo || "")];
    const blockers = [...new Set([...processedBlockers, ...linePlanBlockers(linePlans), ...(!amount ? ["未识别成交金额"] : [])])];
    preparedOrderSnapshots.set(orderId, {
      orderId,
      text,
      sellerMemo: authoritativeSellerMemo,
      frame: source.frame,
      preparedAt: Date.now()
    });
    return {
      sequence: payload?.visibleIndex || "-",
      orderId,
      amount,
      product: linePlans.map((plan, index) => `${index + 1}. ${plan.parsed.productCode || "未识别"} | ${plan.parsed.crafts.join("+") || "无工艺"} | ${plan.catalogMatch.extracted?.color || "未识别颜色"}`).join("；"),
      size: `${formatOrderSizes(parsed)} | 共 ${parsed.quantity || 1}件`,
      pullDirection,
      quoteRemark: quoteRemark || "空（默认方向不写备注）",
      catalog: linePlans.map((plan, index) => plan.catalogMatch.status === "unique" ? `${index + 1}. ${plan.catalogMatch.match.id} | ${plan.catalogMatch.match.specification} | ${plan.catalogMatch.match.color}` : `${index + 1}. 未唯一命中`).join("；"),
      selection: linePlans.map((plan, index) => `${index + 1}. ${plan.resolvedMaterial?.outputText || "未确认"}`).join("；"),
      ready: blockers.length === 0,
      status: blockers.length ? `已拦截：${blockers.join("；")}` : hasPendingResume ? `检测到未完成断点，将继续凭证 ${pendingResume.voucher || "待恢复"}` : "参数完整，可以抄单"
    };
  });
  await browserContext.exposeBinding("__codexConfirmBatch", async (source, infos) => {
    if (activeBatchQueue && !["completed", "paused"].includes(activeBatchQueue.status)) throw new Error("已有连续抄单批次正在执行");
    const orders = Array.isArray(infos) ? infos.filter((info) => info?.ready && /^\d{7}$/.test(String(info.orderId))) : [];
    if (orders.length < 2 || orders.length !== infos.length) throw new Error("批量预检未全部通过");
    const batchId = createBatchId();
    activeBatchQueue = new BatchQueue({ batchId, orders });
    auditStore.createBatch({ batchId, mode: "continuous", orders, summary: { source: "erp-checkboxes" } });
    persistActiveBatch();
    console.log(`[连续抄单] 批次 ${batchId} 已建立，共 ${orders.length} 笔，开始按页面序号执行`);
    try {
      await scheduleNextBatchOrder(source.frame);
      return true;
    } catch (error) {
      activeBatchQueue.pauseCurrent(error.message);
      persistActiveBatch();
      auditStore.finishBatch(batchId, { status: "paused", summary: { error: error.message } });
      const erpPage = context.pages().find((page) => page.url().includes(config.erpUrlPattern));
      await showBatchProgress(erpPage, { error: error.message });
      throw error;
    }
  });
  await browserContext.exposeBinding("__codexConfirmCheckedOrder", (_source, orderId) => {
    const id = String(orderId || "");
    if (!/^\d{7}$/.test(id)) return false;
    browserConfirmedOrders.add(id);
    browserConfirmStartedAt.set(id, Date.now());
    const pendingResume = fs.existsSync(pendingMarkPath) ? JSON.parse(fs.readFileSync(pendingMarkPath, "utf8")) : null;
    const resume = pendingResume?.orderId === id && !pendingResume?.quoteSuccess;
    enqueueBrowserCommand(`${resume ? "RESUME" : "RUN"} ${id}`);
    console.log(`[页面确认] 用户已确认${resume ? "继续未完成订单" : "抄单"} ${id}，开始执行。`);
    return true;
  });
  await browserContext.addInitScript(installOrderClickListener);
  for (const page of browserContext.pages()) {
    for (const frame of page.frames()) await frame.evaluate(installOrderClickListener).catch(() => { });
  }
}


function persistActiveBatch() {
  if (!activeBatchQueue) return;
  fs.mkdirSync(path.dirname(batchStatePath), { recursive: true });
  fs.writeFileSync(batchStatePath, JSON.stringify(activeBatchQueue.snapshot(), null, 2), "utf8");
}

async function showBatchProgress(page, { completed = false, error = "" } = {}) {
  if (!activeBatchQueue || !page) return;
  const snapshot = activeBatchQueue.snapshot();
  await page.evaluate(({ snapshot, completed, error }) => {
    document.getElementById("codex-batch-progress")?.remove();
    const panel = document.createElement("div"); panel.id = "codex-batch-progress";
    panel.style.cssText = "position:fixed;right:24px;top:24px;z-index:2147483646;width:390px;max-height:80vh;overflow:auto;background:#fff;border:2px solid #1677ff;border-radius:10px;padding:16px;box-shadow:0 12px 36px rgba(0,0,0,.28);font-family:Microsoft YaHei,sans-serif;font-size:14px";
    const icon = { completed: "✅", running: "▶", queued: "○", paused: "⏸" };
    panel.innerHTML = `<div style="font-size:19px;font-weight:700">${completed ? "连续抄单完成" : error ? "连续抄单已暂停" : `连续抄单 ${snapshot.items.filter((x) => x.status === "completed").length}/${snapshot.items.length}`}</div>` +
      snapshot.items.map((item) => `<div style="padding:4px 0;color:${item.status === "paused" ? "#c62828" : "#333"}">${icon[item.status] || "○"} ${item.queueIndex}. ${item.orderId}　${item.status}</div>`).join("") +
      (error ? `<div style="margin-top:8px;color:#c62828">${String(error).replace(/[&<>]/g, "")}</div>` : "");
    document.body.appendChild(panel);
    if (completed) setTimeout(() => panel.remove(), 15000);
  }, { snapshot, completed, error }).catch(() => {});
}

async function scheduleNextBatchOrder(frameHint = null) {
  if (!activeBatchQueue || !["ready", "running"].includes(activeBatchQueue.status)) return;
  const next = activeBatchQueue.startNext();
  persistActiveBatch();
  const erpPage = context.pages().find((page) => page.url().includes(config.erpUrlPattern));
  if (!next) {
    auditStore.finishBatch(activeBatchQueue.batchId, { status: "completed", summary: { completed: activeBatchQueue.completedCount, total: activeBatchQueue.total } });
    if (fs.existsSync(batchStatePath)) fs.unlinkSync(batchStatePath);
    await showBatchProgress(erpPage, { completed: true });
    console.log(`[连续抄单] 批次 ${activeBatchQueue.batchId} 全部完成：${activeBatchQueue.completedCount}/${activeBatchQueue.total}`);
    return;
  }
  let targetFrame = frameHint;
  let checkbox = null;
  for (const page of context.pages()) {
    if (!page.url().includes(config.erpUrlPattern)) continue;
    for (const frame of page.frames()) {
      if (!frame.url().includes("/app/order/order/list.aspx")) continue;
      const orderCell = frame.getByText(next.orderId, { exact: true }).first();
      if (!await orderCell.count().catch(() => 0)) continue;
      const row = orderCell.locator("xpath=ancestor::*[contains(concat(' ',normalize-space(@class),' '),' _jt_row ')][1] | xpath=ancestor::tr[1] | xpath=ancestor::*[@role='row'][1]").first();
      const candidate = row.locator("input._jt_cbx, input[type='checkbox']").first();
      if (await candidate.count().catch(() => 0)) { targetFrame = frame; checkbox = candidate; break; }
    }
    if (checkbox) break;
  }
  if (!checkbox || !targetFrame) throw new Error(`连续队列无法在当前查询池定位订单 ${next.orderId}`);
  await targetFrame.evaluate(() => {
    window.__codexBatchSelecting = true;
    document.querySelectorAll("input._jt_cbx:checked").forEach((node) => { node.checked = false; node.dispatchEvent(new Event("change", { bubbles: true })); });
    window.__codexBatchSelecting = false;
  });
  await checkbox.evaluate((node) => {
    window.__codexBatchSelecting = true; node.checked = true; node.dispatchEvent(new Event("change", { bubbles: true })); window.__codexBatchSelecting = false;
  });
  const prepared = preparedOrderSnapshots.get(next.orderId);
  if (prepared) { prepared.frame = targetFrame; prepared.preparedAt = Date.now(); }
  browserConfirmedOrders.add(next.orderId);
  browserConfirmStartedAt.set(next.orderId, Date.now());
  currentAuditContext = { batchId: activeBatchQueue.batchId, orderId: next.orderId };
  auditStore.startOrder(activeBatchQueue.batchId, next.orderId, next);
  await showBatchProgress(erpPage);
  enqueueBrowserCommand(`RUN ${next.orderId}`);
  console.log(`[连续抄单] 开始第 ${next.queueIndex}/${activeBatchQueue.total} 笔：${next.orderId}`);
}

function startCheckedOrderMonitor(browserContext) {
  const timer = setInterval(async () => {
    if (checkedOrderMonitorBusy) return;
    checkedOrderMonitorBusy = true;
    try {
      let found = null;
      for (const page of browserContext.pages()) {
        for (const frame of page.frames()) {
          if (!frame.url().includes("/app/order/order/list.aspx")) continue;
          const checked = frame.locator("input._jt_cbx:checked");
          const count = await checked.count().catch(() => 0);
          if (count !== 1) {
            if (count > 1) {
              const orderIds = await checked.evaluateAll((nodes) => nodes.map((node) => node.closest("._jt_row, tr, [role='row']")?.innerText?.match(/\b\d{7}\b/)?.[0] || "").filter(Boolean));
              found = { signature: `multiple:${orderIds.join(",")}`, frame, checkbox: null, orderIds };
            } else found = null;
            continue;
          }
          const checkbox = checked.first();
          const orderId = await checkbox.evaluate((node) => node.closest("._jt_row, tr, [role='row']")?.innerText?.match(/\b\d{7}\b/)?.[0] || "").catch(() => "");
          if (orderId) {
            found = { signature: `one:${orderId}`, frame, checkbox };
            break;
          }
        }
        if (found?.checkbox) break;
      }
      const signature = found?.signature || "";
      if (!signature) {
        lastCheckedOrderSignature = "";
        checkedOrderMonitorArmed = true;
        return;
      }
      // 启动时页面可能保留上次的勾选状态。必须先观察到一次“没有勾选”，
      // 再接受用户新产生的勾选信号，防止重启后自动重复抄单。
      if (!checkedOrderMonitorArmed) {
        lastCheckedOrderSignature = signature;
        return;
      }
      if (activeBatchQueue && ["ready", "running"].includes(activeBatchQueue.status)) return;
      const isCollectingBatch = await found.frame.evaluate(() => Boolean(window.__codexBatchCollectionMode)).catch(() => false);
      if (isCollectingBatch) return;
      if (signature !== lastCheckedOrderSignature) {
        lastCheckedOrderSignature = signature;
        lastCheckedOrderChangedAt = Date.now();
        return;
      }
      if (Date.now() - lastCheckedOrderChangedAt < 900) return;
      lastCheckedOrderChangedAt = Number.MAX_SAFE_INTEGER;
      if (found.checkbox) {
        console.log(`[勾选信号] 检测到唯一勾选订单 ${signature.slice(4)}，正在显示确认卡片...`);
        await found.checkbox.evaluate((node) => window.__codexShowCheckedOrderConfirm?.(node));
      } else {
        console.log(`[勾选信号] 检测到同时勾选 ${found.orderIds?.length || 0} 笔订单，正在显示连续抄单预检...`);
        await found.frame.evaluate(() => window.__codexShowBatchConfirm?.());
      }
    } catch { }
    finally { checkedOrderMonitorBusy = false; }
  }, 700);
  timer.unref?.();
}


// ========================= 浏览器后台网络层拦截器 =========================
const orderNetworkCache = new Map();
const ORDER_CACHE_TTL = 30 * 60 * 1000; // 缓存 30 分钟过期，防止驻留旧数据冒充最新订单
const ORDER_CACHE_MAX = 500; // 上限 500 笔，超出按先入先出淘汰

function getCachedOrder(orderId) {
  const entry = orderNetworkCache.get(orderId);
  if (!entry) return null;
  if (Date.now() - (entry.timestamp || 0) > ORDER_CACHE_TTL) {
    orderNetworkCache.delete(orderId);
    return null;
  }
  return entry;
}

function trimOrderCache() {
  const excess = orderNetworkCache.size - ORDER_CACHE_MAX;
  if (excess <= 0) return;
  const keys = orderNetworkCache.keys();
  for (let i = 0; i < excess; i += 1) orderNetworkCache.delete(keys.next().value);
}

function extractOrdersFromData(data, sourceUrl = "") {
  if (!data || typeof data !== "object") return;
  const queue = [data];
  const visited = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        if (item && typeof item === "object") queue.push(item);
      }
      continue;
    }

    const rawId = current.so_id || current.o_id || current.order_id || current.orderId || current.io_id || null;
    const strId = String(rawId || "").trim();

    if (strId && /^\d{6,12}$/.test(strId)) {
      const buyerMemo = current.buyer_memo || current.buyer_message || current.buyerMessage || current.buyer_remark || "";
      const sellerMemo = current.remark || current.seller_memo || current.sellerMemo || current.seller_remark || current.note || "";
      const amount = current.pay_amount ?? current.paid_amount ?? current.payment ?? current.amount ?? current.total_amount ?? "";
      const address = current.receiver_address || current.address || [current.receiver_state, current.receiver_city, current.receiver_district, current.receiver_address].filter(Boolean).join("") || "";
      const buyerAccount = current.shop_buyer_id || current.buyer_id || current.buyer_name || current.buyer_account || "";
      const items = Array.isArray(current.items) ? current.items : (Array.isArray(current.order_items) ? current.order_items : []);
      const itemDesc = items.map((i) => `${i.name || i.title || ""} ${i.sku_name || i.properties_value || ""} ${i.qty || i.amount || ""}`).join(" ");

      const combinedText = [
        strId,
        buyerAccount,
        sellerMemo,
        buyerMemo,
        itemDesc,
        amount ? `已付金额: ${amount}` : "",
        address
      ].filter(Boolean).join(" ");

      orderNetworkCache.set(strId, {
        orderId: strId,
        raw: current,
        combinedText,
        amount: String(amount || ""),
        sellerMemo,
        buyerMemo,
        sourceUrl,
        timestamp: Date.now()
      });
    }

    for (const key of Object.keys(current)) {
      const child = current[key];
      if (child && typeof child === "object" && !visited.has(child)) {
        queue.push(child);
      }
    }
  }
}

function setupNetworkInterception(browserContext) {
  browserContext.on("response", async (response) => {
    try {
      const url = response.url();
      if (!url.includes("erp321.com") && !url.includes("jushuitan")) return;
      if (/\.(css|png|jpg|jpeg|gif|svg|woff|woff2|ico)$/i.test(url)) return;

      const contentType = response.headers()["content-type"] || "";
      if (!contentType.includes("json") && !contentType.includes("text") && !contentType.includes("javascript")) return;

      const text = await response.text().catch(() => "");
      if (!text || text.length < 30) return;

      if (/\b\d{7}\b/.test(text) || /"so_id"|"order_id"|"items"|"buyer_memo"|"seller_memo"/i.test(text)) {
        try {
          const json = JSON.parse(text);
          const prevCount = orderNetworkCache.size;
          extractOrdersFromData(json, url);
          trimOrderCache();
          const newCount = orderNetworkCache.size;
          if (newCount > prevCount) {
            console.log(`[后台网络拦截] 从聚水潭接口捕获到新订单数据，新增 ${newCount - prevCount} 笔，累计缓存 ${newCount} 笔`);
          }
        } catch {
          const match = text.match(/^[a-zA-Z0-9_$]+\(([\s\S]+)\);?$/);
          if (match) {
            try {
              const json = JSON.parse(match[1]);
              extractOrdersFromData(json, url);
            } catch { }
          }
        }
      }
    } catch { }
  });
}
// =========================================================================

async function openConfiguredPage(pattern, url, name) {
  const existing = context.pages().find((page) => page.url().includes(pattern));
  if (existing) return existing;
  const page = await context.newPage();
  console.log(`正在打开${name}：${url}`);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (error) {
    console.log(`${name}页面仍在加载，请在浏览器中检查：${error.message}`);
  }
  return page;
}

async function readSelectedOrderText(page, specifiedOrderId = null) {
  // 1. 如果用户明确指定了单号 (如 run 2598202)
  if (specifiedOrderId) {
    // 页面确认卡片刚刚已经读取并校验过同一订单。复用其高保真文本，
    // 但必须重新验证快照未过期、订单行仍存在且仍处于唯一勾选态。
    const prepared = preparedOrderSnapshots.get(String(specifiedOrderId));
    if (prepared && Date.now() - prepared.preparedAt <= 60_000 && prepared.text.includes(String(specifiedOrderId))) {
      const preparedFrame = prepared.frame;
      const orderCell = preparedFrame?.getByText(String(specifiedOrderId), { exact: true }).first();
      if (orderCell && await orderCell.count().catch(() => 0)) {
        const structuredRow = orderCell.locator("xpath=ancestor::*[contains(concat(' ',normalize-space(@class),' '),' _jt_row ')][1]");
        const row = (await structuredRow.count().catch(() => 0))
          ? structuredRow
          : orderCell.locator("xpath=ancestor::tr[1] | xpath=ancestor::*[@role='row'][1]").first();
        const checkbox = row.locator("input[type='checkbox']:checked").first();
        const checkedCount = await checkbox.count().catch(() => 0);
        const frameCheckedCount = await preparedFrame.locator("input._jt_cbx:checked").count().catch(() => 0);
        if (checkedCount === 1 && frameCheckedCount === 1) {
          preparedOrderSnapshots.delete(String(specifiedOrderId));
          console.log(`[确认快照直达] 复用确认卡片已校验的订单 ${specifiedOrderId}，跳过重复全页扫描`);
          return {
            text: prepared.text,
            orderId: String(specifiedOrderId),
            checkbox,
            frame: preparedFrame,
            sellerMemo: prepared.sellerMemo,
            selectionVerifiedAt: Date.now(),
            fromPreparedSnapshot: true
          };
        }
      }
    }
    // 方案 A 优先: 检查后台网络拦截缓存
    const cached = getCachedOrder(specifiedOrderId);
    if (cached) {
      console.log(`[后台数据直达] 成功从网络拦截层直接提取到订单 [${specifiedOrderId}] 的高保真原始数据！无需进行脆弱的 DOM 坐标识别。`);

      // 辅助定位 DOM 复选框 (用于后续打“已抄”备注与自动取消勾选)
      let foundCheckbox = null;
      let foundFrame = page.mainFrame();
      for (const frame of page.frames()) {
        const orderCell = frame.getByText(specifiedOrderId, { exact: true }).first();
        if (await orderCell.count().catch(() => 0)) {
          foundFrame = frame;
          // 就近锁定 tr / role=row，严禁 div.row 巨容器（.first() 按文档序会取到最外层祖先）
          const row = orderCell.locator("xpath=ancestor::tr[1] | xpath=ancestor::*[@role='row'][1]").first();
          if (await row.count().catch(() => 0)) {
            // 归属核验：行内必须确实包含目标单号，否则视为错位匹配，绝不信
            const rowText = await row.innerText().catch(() => "");
            if (!rowText.includes(specifiedOrderId)) continue;
            const cb = row.locator("input[type='checkbox']").first();
            if (await cb.count().catch(() => 0)) {
              // 坚决排除表头全选框
              const isHeader = await cb.evaluate((el) =>
                Boolean(el.closest("thead, th, .el-table__header, .ant-table-header")) ||
                el.id?.toLowerCase().includes("all") ||
                el.getAttribute("aria-label")?.includes("全选")
              ).catch(() => true);
              if (!isHeader) {
                foundCheckbox = cb;
                break;
              }
            }
          }
        }
      }

      return {
        text: cached.combinedText,
        orderId: specifiedOrderId,
        checkbox: foundCheckbox,
        frame: foundFrame,
        sellerMemo: String(cached.sellerMemo ?? ""),
        fromNetwork: true
      };
    }

    // 方案 B 兜底: 网络缓存暂无该单时，在主表格中直接按单号文字精准反查目标行 (杜绝盲猜)
    console.log(`[精准反查] 订单 [${specifiedOrderId}] 尚未在网络流中捕获，正在主表格中按单号文字精准定位目标行...`);
    for (const frame of page.frames()) {
      const orderCell = frame.getByText(specifiedOrderId, { exact: true }).first();
      if (await orderCell.count().catch(() => 0)) {
        // 定位订单行，解禁高度限制至 300px
        const rowData = await orderCell.evaluate((node, targetId) => {
          let row = null;
          let cur = node.parentElement;
          while (cur && cur !== document.body) {
            const h = cur.offsetHeight || cur.getBoundingClientRect().height;
            if (h >= 18 && h <= 300) row = cur;
            if (h > 300) break;
            cur = cur.parentElement;
          }
          if (!row) row = node.closest("tr, [role='row']");
          const leftText = row ? (row.innerText || "").trim().replace(/\t+/g, " ") : "";
          const rowBox = (row || node).getBoundingClientRect();

          // 扫描同一行垂直区间 [top - 5, bottom + 5] 的右侧冻结列单元格
          const rightParts = [];
          const seen = new Set();
          const candidates = document.querySelectorAll("td, div[role='gridcell'], div");
          for (const cand of candidates) {
            if (row && row.contains(cand)) continue;
            const b = cand.getBoundingClientRect();
            if (b.height < 5 || b.height > 300 || b.width < 5) continue;
            if (b.left < 160) continue; // X 轴隔离：排除左侧筛选栏同高度文本污染
            const cY = b.top + b.height / 2;
            if (cY < rowBox.top - 5 || cY > rowBox.bottom + 5) continue;

            const val = (cand.innerText || "").trim().replace(/\s+/g, " ");
            if (!val || val.length > 300 || seen.has(val)) continue;
            const childHasSame = [...cand.children].some((c) => (c.innerText || "").trim().replace(/\s+/g, " ") === val);
            if (childHasSame) continue;

            seen.add(val);
            rightParts.push({ x: b.left, val });
          }

          const rightText = rightParts.sort((a, b) => a.x - b.x).map((i) => i.val).join(" ");
          return `${leftText} ${rightText}`.trim();
        }, specifiedOrderId).catch(() => "");

        if (rowData && rowData.includes(specifiedOrderId)) {
          let cb = null;
          const parentRow = orderCell.locator("xpath=ancestor::tr[1] | xpath=ancestor::*[@role='row'][1]").first();
          if (await parentRow.count().catch(() => 0)) {
            const candCb = parentRow.locator("input[type='checkbox']").first();
            if (await candCb.count().catch(() => 0)) {
              // 与方案 A 同一铁律：坚决排除表头全选框
              const isHeader = await candCb.evaluate((el) =>
                Boolean(el.closest("thead, th, .el-table__header, .ant-table-header")) ||
                el.id?.toLowerCase().includes("all") ||
                el.getAttribute("aria-label")?.includes("全选")
              ).catch(() => true);
              if (!isHeader) cb = candCb;
            }
          }
          return {
            text: rowData,
            orderId: specifiedOrderId,
            checkbox: cb,
            frame
          };
        }
      }
    }

    throw new Error(`未在聚水潭界面或网络流中定位到订单号 [${specifiedOrderId}]，请确认该单已在当前表格中展示！`);
  }

  // 2. 如果用户未指定单号 (只输入 run)
  const checkedItems = [];

  for (const frame of page.frames()) {
    const checkedBoxes = frame.locator("input[type='checkbox']:checked");
    const count = await checkedBoxes.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const checkbox = checkedBoxes.nth(index);
      if (!(await checkbox.isVisible().catch(() => false))) continue;

      const rowData = await checkbox.evaluate((cb) => {
        const box = cb.getBoundingClientRect();

        // 防线 1: 物理 X 坐标硬隔离 (左侧查询树复选框通常在 X < 160px，主表格复选框在 X >= 180px)
        if (box.left < 160) return null;

        // 防线 2: 表头与侧边栏语义过滤
        if (
          cb.closest("thead") ||
          cb.closest(".ant-table-header") ||
          cb.closest(".el-table__header") ||
          cb.id?.toLowerCase().includes("all") ||
          cb.getAttribute("aria-label")?.includes("全选") ||
          cb.parentElement?.innerText?.includes("内部订单号")
        ) {
          return null;
        }

        let isLeftSidebar = false;
        let cur = cb.parentElement;
        while (cur && cur !== document.body) {
          const t = (cur.innerText || "").slice(0, 300);
          if (/回车批量搜索|双地址订单|查询池|菜单设置|订单状态/.test(t) && !/制作宽|高\d|\b\d{7}\b/.test(t)) {
            isLeftSidebar = true;
            break;
          }
          cur = cur.parentElement;
        }
        if (isLeftSidebar) return null;

        // 防线 3: 提取单行容器 (放宽至 300px 以完整容纳多标签与多行长地址)
        let row = null;
        cur = cb.parentElement;
        while (cur && cur !== document.body) {
          const h = cur.offsetHeight || cur.getBoundingClientRect().height;
          if (h >= 18 && h <= 300) {
            row = cur;
          } else if (h > 300) {
            break;
          }
          cur = cur.parentElement;
        }
        if (!row) row = cb.closest("tr, [role='row']");
        const leftText = row ? (row.innerText || "").trim().replace(/\t+/g, " ") : "";
        const rowBox = (row || cb).getBoundingClientRect();

        // 防线 4: 右侧冻结列匹配 (按整行 [top - 5, bottom + 5] 范围扫描)
        const rightParts = [];
        const seen = new Set();
        const candidates = document.querySelectorAll("td, div[role='gridcell'], div");
        for (const node of candidates) {
          if (row && row.contains(node)) continue;
          const b = node.getBoundingClientRect();
          if (b.height < 5 || b.height > 300 || b.width < 5) continue;
          if (b.left < 160) continue; // X 轴隔离：排除左侧筛选栏同高度文本污染
          const cellY = b.top + b.height / 2;
          if (cellY < rowBox.top - 5 || cellY > rowBox.bottom + 5) continue;

          const val = (node.innerText || "").trim().replace(/\s+/g, " ");
          if (!val || val.length > 300 || seen.has(val)) continue;
          const childHasSame = [...node.children].some((c) => (c.innerText || "").trim().replace(/\s+/g, " ") === val);
          if (childHasSame) continue;

          seen.add(val);
          rightParts.push({ x: b.left, val });
        }

        const rightText = rightParts.sort((a, b) => a.x - b.x).map((item) => item.val).join(" ");
        const text = `${leftText} ${rightText}`.trim();
        const ids = text.match(/\b\d{6,}\b/g) || [];
        if (!ids.length) return null;
        return { text, ids };
      }).catch(() => null);

      if (rowData && rowData.ids?.length) {
        // 订单号择优：优先命中网络缓存中的真实单号，其次取 7 位数字，避免手机号等长数字冒充当首
        const orderId = rowData.ids.find((id) => orderNetworkCache.has(id))
          || rowData.ids.find((id) => /^\d{7}$/.test(id))
          || rowData.ids[0];
        checkedItems.push({
          frame,
          checkbox,
          text: rowData.text,
          orderId
        });
      }
    }
  }

  if (checkedItems.length === 0) {
    const clickedId = lastClickedOrder && Date.now() - lastClickedOrder.timestamp < 30 * 60 * 1000
      ? lastClickedOrder.orderId
      : null;
    if (clickedId) {
      console.log(`[人机共存] 未勾选复选框，采用最后点击的订单 [${clickedId}]。`);
      return readSelectedOrderText(page, clickedId);
    }
    throw new Error("未识别到目标订单：请点击订单所在行（会出现橙色左边线），或勾选该行左侧复选框后重试。");
  }

  if (checkedItems.length > 1) {
    const foundIds = [...new Set(checkedItems.map((r) => r.orderId).filter(Boolean))];
    throw new Error(`【防串单拦截】当前页面同时勾选了 ${checkedItems.length} 笔订单（包含订单号: ${foundIds.join(", ") || "未知"}）！必须且只能勾选 1 笔要处理的订单，请在聚水潭中取消多余勾选后重试！`);
  }

  const selected = checkedItems[0];
  // 优先尝试用该单号从网络缓存中获取最高纯度的数据
  const cached = getCachedOrder(selected.orderId);
  const finalText = cached ? cached.combinedText : selected.text;
  if (cached) {
    console.log(`[网络层增强] 勾选订单 [${selected.orderId}] 成功从后台网络缓存匹配到高保真原始数据！`);
  }

  return { text: finalText, orderId: selected.orderId, checkbox: selected.checkbox, frame: selected.frame };
}

async function openQuoteEditPage(page) {
  if (page.url().includes("Accounts_Users/Login")) {
    throw new Error("抄单系统尚未登录，请先在自动化专用 Edge 中登录");
  }
  console.log(`[报价单 3.1] 当前页面：${decodeURIComponent(page.url())}`);
  const addUrl = new URL("/仓库通用异动单据1_XS/Edit/AAAAA", config.quoteUrl).href;
  console.log(`[报价单 3.2] 直接进入系统固定新建入口：${decodeURIComponent(addUrl)}`);
  await page.goto(addUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  if (page.url().includes("Accounts_Users/Login")) {
    throw new Error("抄单系统登录已失效，请重新登录");
  }
  console.log(`[报价单 3.3] 新建页已加载：${decodeURIComponent(page.url())}`);
  const voucherInput = page.locator("input[name='凭证编号']");
  const contactInput = page.locator(config.selectors.quoteContact);
  const amountInput = page.locator(config.selectors.quoteAmount);
  await contactInput.waitFor({ state: "visible", timeout: 15000 });
  const [voucher, contact, amount] = await Promise.all([
    voucherInput.inputValue().catch(() => ""),
    contactInput.inputValue().catch(() => ""),
    amountInput.inputValue().catch(() => "")
  ]);
  if (voucher.trim() || contact.trim() || amount.trim()) {
    throw new Error(`报价单添加页不是空白新单，已拦截（凭证号=${voucher || "空"}，联系人=${contact || "空"}，金额=${amount || "空"}）`);
  }
  console.log(`[报价单 3.4] 已验证空白新单：凭证号空、联系人空、金额空；页面：${decodeURIComponent(page.url())}`);
  return page;
}

async function findRemarkEditorAndDialog(page, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidateFrame of page.frames()) {
      const candidates = candidateFrame.locator("textarea:visible, [contenteditable='true']:visible");
      const candidateCount = await candidates.count().catch(() => 0);
      for (let candidateIndex = candidateCount - 1; candidateIndex >= 0; candidateIndex -= 1) {
        const candidate = candidates.nth(candidateIndex);
        const candidateDialog = candidate.locator("xpath=ancestor::*[.//*[normalize-space()='确定']][1]");
        if (await candidateDialog.count().catch(() => 0)) {
          return { editor: candidate, dialog: candidateDialog };
        }
      }
    }
    await page.waitForTimeout(200);
  }
  return null;
}

function decodeHtmlValue(value = "") {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function saveRemarkThroughDirectRequest(page, targetOrderId, originalSellerMemo, confirm) {
  const startedAt = Date.now();
  const baseUrl = new URL(`/app/order/order/float/remark.aspx?o_id=${encodeURIComponent(targetOrderId)}`, page.url()).href;
  const request = page.context().request;
  const getResponse = await request.get(baseUrl, { timeout: 8000 });
  if (!getResponse.ok()) throw new Error(`备注直连接口读取失败：HTTP ${getResponse.status()}`);
  const html = await getResponse.text();
  const extractInput = (name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return html.match(new RegExp(`name=["']${escaped}["'][^>]*value=["']([^"']*)`, "i"))?.[1]
      || html.match(new RegExp(`value=["']([^"']*)["'][^>]*name=["']${escaped}["']`, "i"))?.[1]
      || "";
  };
  const viewState = decodeHtmlValue(extractInput("__VIEWSTATE"));
  const viewStateGenerator = decodeHtmlValue(extractInput("__VIEWSTATEGENERATOR"));
  if (!viewState || !viewStateGenerator) throw new Error("备注直连接口未返回ASP.NET防伪字段");
  if (typeof originalSellerMemo !== "string") throw new Error("网络订单数据未提供可靠原卖家备注，禁止直连覆盖");
  const original = originalSellerMemo;
  if (/^\s*已抄/.test(original)) throw new Error("卖家备注已含“已抄”，禁止重复回写及重复抄单");
  const updated = original.startsWith("已抄") ? original : `已抄${original}`;
  if (!confirm) return { original, updated, confirmed: false, method: "direct-request" };

  const callbackParam = JSON.stringify({ Method: "Save", Args: [updated, ""], CallControl: "{page}" });
  const form = new URLSearchParams({
    __VIEWSTATE: viewState,
    __VIEWSTATEGENERATOR: viewStateGenerator,
    remark: updated,
    __CALLBACKID: "ACall1",
    __CALLBACKPARAM: callbackParam
  });
  const postResponse = await request.post(`${baseUrl}&ts___=${Date.now()}&am___=Save`, {
    timeout: 8000,
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      referer: baseUrl
    },
    data: form.toString()
  });
  if (!postResponse.ok()) throw new Error(`备注直连接口保存失败：HTTP ${postResponse.status()}`);
  const raw = await postResponse.text();
  const outerText = raw.includes("|") ? raw.slice(raw.indexOf("|") + 1) : raw;
  const outer = JSON.parse(outerText);
  const response = typeof outer?.ReturnValue === "string" ? JSON.parse(outer.ReturnValue) : outer;
  if (!response?.Return) throw new Error(`备注直连接口保存失败：${response?.Message || outer?.Message || "服务器未返回成功"}`);
  const savedRemark = String(response.Remark || "");
  if (savedRemark.trim() !== updated.trim()) throw new Error(`备注直连接口返回值不一致：期望“${updated}”，实际“${savedRemark || "空"}”`);
  console.log(`[备注耗时] 直连接口读取原备注并保存验证：${Date.now() - startedAt}ms`);
  logStep(9, 11, "ERP回写", `通过聚水潭备注直连接口在订单 ${targetOrderId} 原备注前追加“已抄”，服务器已确认回写成功`);
  return { original, updated: savedRemark, confirmed: true, method: "direct-request" };
}

async function saveRemarkThroughCapturedEndpoint(page, targetRow, targetOrderId, confirm) {
  const startedAt = Date.now();
  if (!targetRow || !(await targetRow.count().catch(() => 0))) return null;
  const remarkCell = targetRow.locator('[data-id="remark"]').first();
  if (!(await remarkCell.count().catch(() => 0))) return null;

  await remarkCell.hover().catch(() => { });
  const editButton = remarkCell.locator(".h_btn_show_remark").first();
  if (!(await editButton.count().catch(() => 0))) return null;
  await editButton.click({ force: true, noWaitAfter: true });

  let remarkFrame = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    remarkFrame = page.frames().find((frame) => frame.url().includes("/app/order/order/float/remark.aspx") && frame.url().includes(`o_id=${targetOrderId}`)) || null;
    if (remarkFrame) break;
    await page.waitForTimeout(50);
  }
  if (!remarkFrame) return null;

  const editor = remarkFrame.locator("#remark");
  await editor.waitFor({ state: "visible", timeout: 4000 });
  console.log(`[备注耗时] 定位订单行并打开备注页：${Date.now() - startedAt}ms`);
  const original = await editor.inputValue();
  const updated = original.startsWith("已抄") ? original : `已抄${original}`;
  await editor.fill(updated);
  if (!confirm) return { original, updated, confirmed: false, method: "captured-endpoint" };

  const response = await remarkFrame.evaluate((nextRemark) => new Promise((resolve, reject) => {
    if (typeof window._ACP !== "function") {
      reject(new Error("备注页未暴露保存回调接口"));
      return;
    }
    const timer = setTimeout(() => reject(new Error("备注保存接口响应超时")), 12000);
    window._ACP("Save", (raw) => {
      clearTimeout(timer);
      try {
        resolve(raw ? JSON.parse(raw) : null);
      } catch (error) {
        reject(error);
      }
    }, nextRemark, "");
  }), updated);

  if (!response?.Return) throw new Error(`聚水潭备注接口保存失败：${response?.Message || response?.Msg || "服务器未返回成功"}`);
  const savedRemark = String(response.Remark || "");
  // 聚水潭服务器会自动清理备注首尾空格；业务内容一致即可视为保存成功。
  if (savedRemark.trim() !== updated.trim()) throw new Error(`聚水潭备注接口返回值不一致：期望“${updated}”，实际“${savedRemark || "空"}”`);
  await remarkFrame.evaluate(() => { if (typeof parent._HideFloat === "function") parent._HideFloat(); }).catch(() => { });
  console.log(`[备注耗时] 服务器保存并验证完成：${Date.now() - startedAt}ms（总耗时）`);
  logStep(9, 11, "ERP回写", `通过聚水潭备注 Save 接口在订单 ${targetOrderId} 原备注前追加“已抄”，服务器已确认回写成功`);
  return { original, updated: savedRemark, confirmed: true, method: "captured-endpoint" };
}


// ========================= 顶部批量操作单选物理熔断守门员 =========================
async function assertSingleOrderSelected(page, targetOrderId) {
  let validChecked = [];
  for (const frame of page.frames()) {
    const checkedBoxes = frame.locator("input[type='checkbox']:checked");
    const count = await checkedBoxes.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const cb = checkedBoxes.nth(i);
      if (!(await cb.isVisible().catch(() => false))) continue;
      const isHeaderOrSidebar = await cb.evaluate((el) => {
        if (el.closest("thead, th, .el-table__header, .ant-table-header")) return true;
        if (el.id?.toLowerCase().includes("all") || el.getAttribute("aria-label")?.includes("全选")) return true;
        if (el.parentElement?.innerText?.includes("内部订单号")) return true;
        const box = el.getBoundingClientRect();
        if (box.left < 160) return true;
        return false;
      }).catch(() => false);
      if (!isHeaderOrSidebar) {
        validChecked.push(cb);
      }
    }
  }

  if (validChecked.length !== 1) {
    throw new Error(`【安全熔断拦截】当前聚水潭表格中处于勾选态的有效订单数为 ${validChecked.length} 笔（非唯一单选）！为防止串单批量修改备注或误审核，已严禁触发顶部工具栏批量操作！`);
  }
}
// =================================================================================

async function prependCopiedRemark(page, { confirm = false, targetOrderId = null, selectedCheckbox = null, selectedFrame = null, selectionVerifiedAt = 0, originalSellerMemo = null } = {}) {
  const remarkStartedAt = Date.now();
  // 快速安全证明：复用刚刚确认的复选框，确认它仍连接、仍勾选且所属行包含目标单号。
  // 证明通过后直接调用备注接口，完全跳过耗时的浮窗和 iframe；失败则自动回退原界面双引擎。
  if (selectedCheckbox && ((selectionVerifiedAt && Date.now() - selectionVerifiedAt <= 10_000) || await selectedCheckbox.count().catch(() => 0))) {
    const selectionProof = selectionVerifiedAt && Date.now() - selectionVerifiedAt <= 10_000
      ? true
      : await selectedCheckbox.evaluate((element, orderId) => {
        const row = element.closest("._jt_row, tr, [role='row']");
        return Boolean(element.isConnected && element.checked && row && (row.innerText || "").includes(orderId));
      }, String(targetOrderId || "")).catch(() => false);
    if (selectionProof && typeof originalSellerMemo === "string") {
      const directResult = await saveRemarkThroughDirectRequest(page, targetOrderId, originalSellerMemo, confirm).catch((error) => {
        console.log(`[备注直连容灾] ${error.message}，切换原界面路径...`);
        return null;
      });
      if (directResult?.confirmed || (!confirm && directResult)) return directResult;
    }
  }
  // 0. 确认卡片通常就在聚水潭前台；只有页面确实隐藏时才切换，
  // 避免 Edge/CDP 对已在前台页面重复 bringToFront 产生约 2 秒延迟。
  const erpAlreadyVisible = await page.evaluate(() => document.visibilityState === "visible").catch(() => false);
  if (!erpAlreadyVisible) await page.bringToFront().catch(() => { });

  // 1. 精准定位目标订单所在的行容器：优先复用已知 checkbox/框架，避免逐帧扫描。
  let targetRow = null;
  let targetFrame = selectedFrame || page.mainFrame();

  if (selectedCheckbox && (await selectedCheckbox.count().catch(() => 0))) {
    const isLive = await selectedCheckbox.evaluate((el) => el.isConnected).catch(() => false);
    if (isLive) {
      const jtableRow = selectedCheckbox.locator("xpath=ancestor::*[contains(concat(' ',normalize-space(@class),' '),' _jt_row ')][1]");
      targetRow = (await jtableRow.count().catch(() => 0))
        ? jtableRow
        : selectedCheckbox.locator("xpath=ancestor::tr[1] | xpath=ancestor::*[@role='row'][1]").first();
    }
  }

  const preferredFrames = [selectedFrame, ...page.frames()].filter((frame, index, all) => frame && all.indexOf(frame) === index);
  for (const frame of preferredFrames) {
    if (targetRow) break;
    if (targetOrderId) {
      const orderCell = frame.getByText(targetOrderId, { exact: true }).first();
      if (await orderCell.count().catch(() => 0)) {
        targetFrame = frame;
        await orderCell.scrollIntoViewIfNeeded().catch(() => { });
        const jtableRow = orderCell.locator("xpath=ancestor::*[contains(concat(' ',normalize-space(@class),' '),' _jt_row ')][1]");
        targetRow = (await jtableRow.count().catch(() => 0))
          ? jtableRow
          : orderCell.locator("xpath=ancestor::tr[1] | xpath=ancestor::*[@role='row'][1]").first();
        break;
      }
    }
  }

  if (targetRow) await targetRow.scrollIntoViewIfNeeded().catch(() => { });
  console.log(`[备注耗时] 切换聚水潭并锁定订单行：${Date.now() - remarkStartedAt}ms`);

  // 核心铁律：严禁在此执行任何 checked.click() 激活复选框的操作！行内编辑完全无需复选框！

  let found = null;

  // [引擎 0] 使用抓包确认的备注页 Save 回调。精确绑定订单号，并校验服务器返回值。
  const endpointResult = await saveRemarkThroughCapturedEndpoint(page, targetRow, targetOrderId, confirm).catch((error) => {
    console.log(`[备注接口容灾] ${error.message}，切换界面兼容路径...`);
    return null;
  });
  if (endpointResult?.confirmed || (!confirm && endpointResult)) return endpointResult;

  // 3. [引擎 1]: 目标行行内精准触发 (同层直达，绝不跨行漂移)
  if (targetRow && (await targetRow.count().catch(() => 0))) {
    await targetRow.evaluate((el) => {
      el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
    }).catch(() => { });

    // 在目标行内查找编辑元素
    const rowEdits = targetRow.locator("[title*='修改'], [title*='备注'], .btn-edit, [class*='edit'], [class*='remark'], span, a, i").filter({ hasText: /^改$|修改|备注/ });
    const editCount = await rowEdits.count().catch(() => 0);
    let inlineEditBtn = null;
    for (let i = 0; i < editCount; i += 1) {
      const candidate = rowEdits.nth(i);
      const isVisible = await candidate.isVisible().catch(() => false);
      const text = (await candidate.innerText().catch(() => "")).trim();
      const title = (await candidate.getAttribute("title").catch(() => "")) || "";
      if (isVisible && (/^改$/.test(text) || /修改|备注/.test(title))) {
        inlineEditBtn = candidate;
        break;
      }
    }

    if (!inlineEditBtn && editCount > 0) {
      inlineEditBtn = rowEdits.first();
    }

    if (inlineEditBtn) {
      console.log(`[引擎1] 锁定订单 [${targetOrderId || "当前单"}] 行内备注‘改’按钮，原生派发点击...`);
      await inlineEditBtn.evaluate((el) => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        if (el.click) el.click();
      }).catch(() => { });
      await inlineEditBtn.click({ force: true, timeout: 2000 }).catch(() => { });

      // 给 SPA 充分响应时间，等待 4000ms
      found = await findRemarkEditorAndDialog(page, 4000);
    }
  }

  // 4. [引擎 2]: 顶部工具栏【修改&标记】容灾触发 (必须经单选绝对熔断守门！)
  if (!found) {
    console.log("[引擎2容灾] 行内‘改’未呼出弹窗，准备切换至顶部工具栏【修改&标记】操作...");
    await assertSingleOrderSelected(page, targetOrderId);

    let toolbarEditBtn = null;
    for (const f of page.frames()) {
      const btn = f.locator("button, a, span, div").filter({ hasText: /修改&标记/ }).first();
      if (await btn.isVisible().catch(() => false)) {
        toolbarEditBtn = btn;
        break;
      }
    }
    if (toolbarEditBtn) {
      await toolbarEditBtn.click({ force: true }).catch(() => { });
      await page.waitForTimeout(500);

      // 下拉菜单定位“修改买家备注”或“修改卖家备注”
      let menuItem = null;
      for (const f of page.frames()) {
        const item = f.locator("li, a, span, div").filter({ hasText: /^修改买家备注$|^修改卖家备注$|^卖家备注$/ }).first();
        if (await item.isVisible().catch(() => false)) {
          menuItem = item;
          break;
        }
      }
      if (!menuItem) {
        for (const f of page.frames()) {
          const item = f.locator("li, a, span, div").filter({ hasText: /修改.*备注|卖家备注/ }).first();
          if (await item.isVisible().catch(() => false)) {
            menuItem = item;
            break;
          }
        }
      }
      if (menuItem) {
        console.log("已点击顶部工具栏‘修改&标记’菜单项，等待备注编辑弹窗...");
        await menuItem.click({ force: true }).catch(() => { });
      }
    }

    found = await findRemarkEditorAndDialog(page, 8000);
  }

  if (!found) throw new Error("双引擎（行内‘改’+顶部‘修改&标记’）触发后，未在 ERP 页面中找到备注编辑弹窗");

  const { editor, dialog } = found;
  const tagName = await editor.evaluate((node) => node.tagName);
  const original = tagName === "TEXTAREA" || tagName === "INPUT"
    ? await editor.inputValue()
    : await editor.innerText();
  const updated = original.startsWith("已抄") ? original : `已抄${original}`;
  await editor.fill(updated);
  if (confirm) {
    await dialog.getByText("确定", { exact: true }).first().click({ force: true });
    // 保存核验：等弹窗关闭，并嗅探保存失败的错误提示
    await dialog.waitFor({ state: "hidden", timeout: 8000 }).catch(() => { });
    const remarkError = page.locator(".el-message--error, .el-notification--error, .ant-message-error, .el-message-box__message").first();
    if (await remarkError.isVisible().catch(() => false)) {
      const errText = ((await remarkError.innerText().catch(() => "")) || "").trim();
      if (errText && !/确认|确定|是否|吗[?？]/.test(errText)) {
        throw new Error(`聚水潭备注保存失败，系统提示：${errText}`);
      }
    }
    logStep(9, 11, "ERP回写", `聚水潭备注前追加‘已抄’，点击弹窗‘确定’保存成功 (当前备注: "${updated}")`);
  } else {
    console.log("已验证聚水潭备注定位；dryRun 模式未点击‘确定’。");
  }
  return { original, updated, confirmed: confirm };
}

async function auditSelectedOrder(page, { confirm = false, targetOrderId = null, selectedCheckbox = null, selectedFrame = null } = {}) {
  await page.bringToFront().catch(() => { });
  await page.waitForTimeout(300);

  // 1. 精准定位目标行
  let row = null;
  let targetFrame = selectedFrame || page.mainFrame();
  for (const frame of page.frames()) {
    if (targetOrderId) {
      const structuredRow = frame.locator("._jt_row").filter({ has: frame.locator('[data-id="o_id"]', { hasText: targetOrderId }) }).first();
      if (await structuredRow.count().catch(() => 0)) {
        targetFrame = frame;
        row = structuredRow;
        await row.scrollIntoViewIfNeeded().catch(() => { });
        break;
      }
      const orderCell = frame.getByText(targetOrderId, { exact: true }).first();
      if (await orderCell.count().catch(() => 0)) {
        targetFrame = frame;
        await orderCell.scrollIntoViewIfNeeded().catch(() => { });
        const jtableRow = orderCell.locator("xpath=ancestor::*[contains(concat(' ',normalize-space(@class),' '),' _jt_row ')][1]");
        row = (await jtableRow.count().catch(() => 0))
          ? jtableRow
          : orderCell.locator("xpath=ancestor::tr[1] | xpath=ancestor::*[@role='row'][1]").first();
        break;
      }
    }
  }
  if (!row && selectedCheckbox && (await selectedCheckbox.count().catch(() => 0))) {
    const isLive = await selectedCheckbox.evaluate((el) => el.isConnected).catch(() => false);
    if (isLive) {
      const jtableRow = selectedCheckbox.locator("xpath=ancestor::*[contains(concat(' ',normalize-space(@class),' '),' _jt_row ')][1]");
      row = (await jtableRow.count().catch(() => 0))
        ? jtableRow
        : selectedCheckbox.locator("xpath=ancestor::tr[1] | xpath=ancestor::*[@role='row'][1]").first();
    }
  }

  if (!row || !(await row.count().catch(() => 0))) {
    throw new Error(`未在聚水潭页面定位到订单 [${targetOrderId || "当前单"}] 的行容器，无法执行审核`);
  }

  if (!confirm) {
    console.log("dryRun 模式：跳过聚水潭右键审核操作。");
    return { success: true, dryRun: true };
  }

  // 2. 优先在对应订单行派发右键点击。先把行居中，避免靠近视口底部时
  //    聚水潭把右键菜单渲染到可视区域之外。
  await row.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" })).catch(() => { });
  await page.waitForTimeout(200);
  await row.click({ button: "right", force: true });
  await page.waitForTimeout(500);

  // 3. 查找右键上下文菜单中的“审核”选项
  let auditItem = null;
  for (const candidateFrame of page.frames()) {
    const items = candidateFrame.locator("li, div, a, span").filter({ hasText: /^✓?\s*审核$/ });
    const itemCount = await items.count().catch(() => 0);
    for (let i = itemCount - 1; i >= 0; i -= 1) {
      const item = items.nth(i);
      if (await item.isVisible().catch(() => false)) {
        auditItem = item;
        break;
      }
    }
    if (auditItem) break;
  }

  // 4. 若右键菜单未弹出，降级容灾点击页面顶部工具栏“审核”按钮 (必须单选绝对熔断！)
  if (!auditItem) {
    console.log("未检测到右键菜单‘审核’项，准备尝试点击页面顶部工具栏‘审核’按钮...");
    await assertSingleOrderSelected(page, targetOrderId);

    for (const f of page.frames()) {
      const topAudit = f.locator("button, a, span, div").filter({ hasText: /^✓?\s*审核$/ }).first();
      if (await topAudit.isVisible().catch(() => false)) {
        auditItem = topAudit;
        break;
      }
    }
  }

  if (!auditItem) {
    throw new Error("未找到聚水潭右键菜单或工具栏中的‘审核’按钮");
  }

  const initialRowText = (await row.innerText().catch(() => "")) || "";
  // 聚水潭的菜单文字有时位于 div.drag 内，Playwright 会将它判定为可见，
  // 但坐标点击仍可能报 outside of the viewport。此处先用正常点击；仅在
  // 已精确锁定可见“审核”项后，才降级为对其可点击父项派发 DOM click。
  try {
    await auditItem.click({ timeout: 2500 });
  } catch (error) {
    if (!/outside of the viewport|not in the viewport/i.test(String(error?.message || error))) throw error;
    console.log("审核菜单项位于视口边缘，切换为菜单 DOM 点击...");
    await auditItem.evaluate((element) => {
      const target = element.closest("li, a, button, [role='menuitem']") || element;
      target.click();
    });
  }
  await page.waitForTimeout(800);

  // 5. 业务二次确认弹窗主动嗅探与处理 (如“该单为预售单，确认审核吗？”；只认弹窗容器内的按钮，避免误点页面上的无关按钮)
  for (const f of page.frames()) {
    const confirmBtn = f.locator(".el-message-box__btns button, .el-dialog__footer button, .modal-footer button, .ant-modal-footer button")
      .filter({ hasText: /^确定$|^确认$|^知道了$/ }).first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      console.log("检测到聚水潭审核二次业务确认弹窗，自动确认放行...");
      await confirmBtn.click({ force: true }).catch(() => { });
      await page.waitForTimeout(600);
      break;
    }
  }

  // 5b. 审核失败提示嗅探 (错误 toast / 非疑问类弹窗，如“该订单已审核”“库存不足”)
  const sniffAuditError = async () => {
    const errorBox = page.locator(".el-message--error, .el-notification--error, .ant-message-error, .el-message-box__message, .modal-body");
    const ebCount = await errorBox.count().catch(() => 0);
    for (let i = 0; i < ebCount; i += 1) {
      const eb = errorBox.nth(i);
      if (!(await eb.isVisible().catch(() => false))) continue;
      const errorText = ((await eb.innerText().catch(() => "")) || "").trim();
      if (!errorText || /确认|确定|是否|吗[?？]/.test(errorText)) continue;
      return errorText;
    }
    return "";
  };
  const immediateError = await sniffAuditError();
  if (immediateError) throw new Error(`聚水潭审核失败，系统提示：${immediateError}`);

  // 6. 轮询核验审核结果：成功后订单要么原地变为“发货中/已审核”，要么从“待审核”过滤列表中消失；
  //    网格重渲染期间行可能瞬时读不到文本，需连续多次读空才认定“已移出列表”
  let isShipping = false;
  let rowLeftView = false;
  let emptyStreak = 0;
  for (let poll = 0; poll < 10; poll += 1) {
    const text = (await row.innerText().catch(() => "")) || "";
    if (!text) {
      emptyStreak += 1;
      if (emptyStreak >= 3) {
        rowLeftView = true;
        isShipping = true;
        break;
      }
    } else {
      emptyStreak = 0;
      if (/发货中|已审核|配货中/.test(text)) {
        isShipping = true;
        break;
      }
      if (initialRowText && text !== initialRowText && !/待审核|未审核/.test(text)) {
        isShipping = true;
        break;
      }
    }
    await page.waitForTimeout(500);
  }

  if (!isShipping) {
    const lateError = await sniffAuditError();
    throw new Error(lateError
      ? `聚水潭审核失败，系统提示：${lateError}`
      : `订单 [${targetOrderId || "当前单"}] 审核后未核验到状态跃迁（仍为待审核或状态未变），请人工检查聚水潭后重试`);
  }
  logStep(10, 11, "ERP审核", `订单 ${targetOrderId || ""} 审核完成，${rowLeftView ? "订单已从待审核列表移除" : "已核验状态跃迁为发货中/已审核"}`);
  return { success: true, isShipping };
}

async function uncheckProcessedOrder(selectedCheckbox, page, targetOrderId, selectedFrame = null) {
  // 1. 优先使用选中的物理 checkbox 引用执行 uncheck
  if (selectedCheckbox) {
    try {
      // Locator 在元素被虚拟表格移除后会等待同类元素重新出现（默认可达30秒）。
      // 先固化为 ElementHandle，之后即使行被移除，状态检查也会立即返回。
      const checkboxHandle = await selectedCheckbox.elementHandle({ timeout: 800 }).catch(() => null);
      const isLive = checkboxHandle
        ? await checkboxHandle.evaluate((el) => el.isConnected).catch(() => false)
        : false;
      if (isLive) {
        // 兜底防线：无论句柄来自哪里，表头全选框一律拒绝操作（防止错位句柄误取消整页勾选）
        const isHeader = await checkboxHandle.evaluate((el) =>
          Boolean(el.closest("thead, th, .el-table__header, .ant-table-header")) ||
          el.id?.toLowerCase().includes("all") ||
          el.getAttribute("aria-label")?.includes("全选")
        ).catch(() => true);
        if (isHeader) {
          console.log(`[安全拦截] 传入的复选框句柄指向表头/全选框，已拒绝对订单 ${targetOrderId || ""} 的取消勾选操作`);
        } else {
          const isChecked = await checkboxHandle.evaluate((el) => Boolean(el.checked)).catch(() => false);
          if (isChecked) {
            // 句柄已通过“仍连接 + 非表头 + 当前已勾选”三重校验，直接派发
            // 原生点击，避免 Playwright actionability 在审核后的虚拟表格上空等数秒。
            await checkboxHandle.evaluate((el) => el.click()).catch(() => { });
            let state = await checkboxHandle.evaluate((el) => ({ connected: el.isConnected, checked: Boolean(el.checked) }))
              .catch(() => ({ connected: false, checked: false }));
            let stillChecked = state.connected && state.checked;
            if (stillChecked) {
              await checkboxHandle.click({ force: true, timeout: 800 }).catch(() => { });
              state = await checkboxHandle.evaluate((el) => ({ connected: el.isConnected, checked: Boolean(el.checked) }))
                .catch(() => ({ connected: false, checked: false }));
              stillChecked = state.connected && state.checked;
            }
            if (stillChecked) throw new Error(`订单 ${targetOrderId || ""} 的复选框取消后仍处于勾选状态`);
            logStep(11, 11, "自动就绪", `物理取消订单 ${targetOrderId || ""} 的复选框勾选，清除断点锁，就绪等待下一单`);
            return;
          }
        }
      }
    } catch { }
  }

  // 2. 备用容灾：仅在主表格数据行中根据单号取消勾选（坚决排除 thead 与全选框）
  if (targetOrderId && page) {
    const frames = [selectedFrame, ...page.frames()].filter((frame, index, all) => frame && all.indexOf(frame) === index);
    for (const frame of frames) {
      const structuredRow = frame.locator("._jt_row").filter({ has: frame.locator('[data-id="o_id"]', { hasText: targetOrderId }) }).first();
      if (await structuredRow.count().catch(() => 0)) {
        const checkbox = structuredRow.locator("input[type='checkbox']:checked").first();
        if (await checkbox.count().catch(() => 0)) {
          await checkbox.uncheck().catch(() => checkbox.click({ force: true }));
          logStep(11, 11, "自动就绪", `通过结构化订单行取消订单 ${targetOrderId} 勾选，清除断点锁，就绪等待下一单`);
          return;
        }
      }
      const orderCell = frame.getByText(targetOrderId, { exact: true }).first();
      if (await orderCell.count().catch(() => 0)) {
        const row = orderCell.locator("xpath=ancestor::tr[1] | xpath=ancestor::*[@role='row'][1]").first();
        if (await row.count().catch(() => 0)) {
          const checkbox = row.locator("input[type='checkbox']:checked").first();
          if (await checkbox.count().catch(() => 0)) {
            const isHeader = await checkbox.evaluate(el => Boolean(el.closest("thead, th, .el-table__header") || el.id?.includes("all"))).catch(() => false);
            if (!isHeader) {
              await checkbox.uncheck().catch(() => checkbox.click({ force: true }));
              logStep(11, 11, "自动就绪", `通过单号匹配取消订单 ${targetOrderId} 勾选，清除断点锁，就绪等待下一单`);
              return;
            }
          }
        }
      }
    }
  }
}

async function saveQuoteHeader(page, { orderId, amount }) {
  const beforeUrl = page.url();
  const voucherBefore = await page.locator("input[name='凭证编号']").inputValue().catch(() => "");
  const contactBefore = await page.locator(config.selectors.quoteContact).inputValue().catch(() => "");
  const amountBefore = await page.locator(config.selectors.quoteAmount).inputValue().catch(() => "");
  if (voucherBefore.trim()) throw new Error(`报价单保存前已有凭证号 ${voucherBefore}，这不是新建单，已拦截以防覆盖`);
  if (contactBefore.trim() !== String(orderId).trim()) throw new Error(`报价单保存前联系人校验失败：期望 ${orderId}，实际 ${contactBefore || "空"}`);
  if (amountBefore.trim() !== String(amount).trim()) throw new Error(`报价单保存前金额校验失败：期望 ${amount}，实际 ${amountBefore || "空"}`);
  console.log(`[报价单 4.1] 保存前复核通过：凭证号空 | 联系人 ${contactBefore} | 成交金额 ¥${amountBefore}`);
  console.log(`[报价单 4.2] 点击保存：#btnsave | 页面：${decodeURIComponent(beforeUrl)}`);
  const headerSaveSignal = Promise.race([
    page.waitForURL((url) => url.href !== beforeUrl && /\/Edit\/XS\d+/i.test(url.href), { timeout: 8000 }).then(() => "页面已进入新凭证"),
    page.waitForFunction(() => {
      const input = document.querySelector("input[name='凭证编号']");
      return /^XS\d{10,}$/.test(String(input?.value || ""));
    }, null, { timeout: 8000 }).then(() => "凭证编号已生成")
  ]).catch(() => "保存信号等待超时，进入最终复核");
  await page.locator("#btnsave").click();
  console.log(`[报价单 4.2] ${await headerSaveSignal}`);
  await page.waitForLoadState("domcontentloaded").catch(() => { });
  await page.locator("#btnsave").waitFor({ state: "visible", timeout: 15000 });

  // 保存失败弹窗嗅探：校验不通过时系统会弹错误提示且停留在原页面（成功提示除外）
  const errorBox = page.locator(".el-message-box__message, .el-message--error, .el-notification__content, .ant-message-error, .modal-body");
  const ebCount = await errorBox.count().catch(() => 0);
  for (let i = 0; i < ebCount; i += 1) {
    const eb = errorBox.nth(i);
    if (!(await eb.isVisible().catch(() => false))) continue;
    const errorText = ((await eb.innerText().catch(() => "")) || "").trim();
    if (!errorText || /成功/.test(errorText)) continue;
    throw new Error(`报价单主表保存失败，系统提示：${errorText}`);
  }

  // 凭证编号重试读取：保存成功后凭证号可能延迟渲染
  let voucherFromPage = "";
  for (let attempt = 0; attempt < 10 && !voucherFromPage; attempt += 1) {
    const voucher = await page.locator("input[name='凭证编号']").inputValue().catch(() => "");
    const bodyText = await page.locator("body").innerText().catch(() => "");
    voucherFromPage = voucher || bodyText.match(/XS\d{10,}/)?.[0] || "";
    if (!voucherFromPage) await page.waitForTimeout(200);
  }
  if (!voucherFromPage) throw new Error(`报价单主表保存后未生成凭证编号（保存前页面：${beforeUrl}；保存后页面：${page.url()}）`);
  const priorOrder = savedVoucherOrders.get(voucherFromPage);
  if (priorOrder && priorOrder !== String(orderId)) {
    throw new Error(`报价单凭证号重复：${voucherFromPage} 已用于订单 ${priorOrder}，当前订单 ${orderId} 已拦截`);
  }
  savedVoucherOrders.set(voucherFromPage, String(orderId));
  const contactAfter = await page.locator(config.selectors.quoteContact).inputValue().catch(() => "");
  if (contactAfter.trim() !== String(orderId).trim()) throw new Error(`报价单保存后联系人异常：期望 ${orderId}，实际 ${contactAfter || "空"}`);
  console.log(`[报价单 4.3] 保存响应完成：新凭证号 ${voucherFromPage} | 联系人 ${contactAfter} | 页面：${decodeURIComponent(page.url())}`);
  logStep(4, 11, "主表保存", `新建报价单保存成功，订单 ${orderId} 生成独立凭证编号: ${voucherFromPage}`);
  return voucherFromPage;
}

async function chooseMaterial(page, searchText, parsed, authoritativeCatalog = null, beforeStep = null, rowNumber = 1, totalRows = 1) {
  if (beforeStep) await beforeStep(5, "选品搜索", `打开物料选择器并搜索：${searchText}`);
  const search = page.locator("#search_xuanze_xiangmubianhao1");
  let clicked = await search.isVisible().catch(() => false);
  // 主表保存后 jqGrid 会异步生成 id=99999999 的空白编辑行。网络稍慢时，
  // “保存”响应已经完成但该行仍未挂载，不能立即误报为 0 行。优先依据
  // jqGrid 的 editable=1 + 行内输入框 + 行内保存按钮识别，并限时等待。
  const editableRows = [];
  const editableRowDeadline = Date.now() + 15000;
  while (Date.now() < editableRowDeadline) {
    editableRows.length = 0;
    const rowCandidates = page.locator("tr[editable='1']");
    const candidateCount = await rowCandidates.count().catch(() => 0);
    for (let index = 0; index < candidateCount; index += 1) {
      const detailRow = rowCandidates.nth(index);
      if (!(await detailRow.isVisible().catch(() => false))) continue;
      if (!(await detailRow.locator("input").count().catch(() => 0))) continue;
      if (!(await detailRow.getByText("保存", { exact: true }).count().catch(() => 0))) continue;
      editableRows.push(detailRow);
    }
    if (editableRows.length >= rowNumber) break;
    await page.waitForTimeout(250);
  }
  if (editableRows.length < rowNumber) {
    throw new Error(`报价单只有 ${editableRows.length} 条可编辑明细行，未生成第 ${rowNumber}/${totalRows} 条目标行；禁止覆盖已有行`);
  }
  const targetDetailRow = editableRows[rowNumber - 1];
  const directCandidates = targetDetailRow.locator("[value='..'], [value='...'], [title*='选择'], a, button, span");
  const directCount = await directCandidates.count();
  for (let index = 0; !clicked && index < directCount; index += 1) {
    const candidate = directCandidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const label = ((await candidate.innerText().catch(() => "")) || (await candidate.getAttribute("value")) || "").trim();
    if (!/^\.{2,3}$/.test(label)) continue;
    const row = candidate.locator("xpath=ancestor::tr[1]");
    if (await row.getByText("保存", { exact: true }).count().catch(() => 0)) {
      await candidate.click();
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    const cells = targetDetailRow.locator("td");
    if ((await cells.count()) >= 4) {
      await cells.nth(2).click({ position: { x: 8, y: 8 } });
      clicked = true;
    }
  }
  if (!clicked) throw new Error("主表保存后未找到明细行的‘..’物料入口");
  await search.waitFor({ state: "visible", timeout: 15000 });
  await search.click();
  // 该 ASP.NET 旧控件依赖逐键事件触发远程筛选；fill + Enter 不会刷新结果表。
  // 保留已验证稳定的逐键输入，避免出现空结果后误入人工接管。
  await search.fill("");
  await search.pressSequentially(searchText, { delay: 30 });
  logStep(5, 11, "选品搜索", `点击明细行“..”物料选择器入口，在弹窗搜索框中清空并输入品号: ${searchText}`);
  const modal = search.locator("xpath=ancestor::*[.//tr and .//*[normalize-space()='单选']][1]");
  await modal.locator("tr").filter({ hasText: parsed.productCode }).first().waitFor({ state: "visible", timeout: 15000 });
  const resultRows = modal.locator("tr:has(input[type='checkbox'])");
  const rowCount = await resultRows.count();
  const modelCode = searchText.split(/\s+/)[1] || "";
  const scoredRows = [];
  for (let index = 0; index < rowCount; index += 1) {
    const row = resultRows.nth(index);
    if (!(await row.isVisible().catch(() => false))) continue;
    const text = (await row.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (!text || !text.includes(parsed.productCode)) continue;
    let score = 30;
    const reasons = [`货号${parsed.productCode}`];
    if (modelCode) {
      const matchFull = text.includes(modelCode);
      const parts = modelCode.split(/(?=白|灰|黑|奶油|粉|绿|蓝|黄|银|米|金|紫|红|咖|驼|橙|麻)/).filter(Boolean);
      const matchParts = parts.length > 1 && parts.every((p) => text.includes(p));
      if (matchFull || matchParts) {
        score += 60;
        reasons.push(`颜色规格${modelCode}匹配`);
      } else {
        score -= 90;
        reasons.push(`缺少颜色规格${modelCode}`);
      }
    }
    const candidateNoDrill = /免打孔|免钉|胀紧/.test(text);
    const needsNoDrill = parsed.crafts.includes("免打孔");
    if (needsNoDrill) {
      if (candidateNoDrill) { score += 60; reasons.push("免钉同义规格匹配"); }
      else { score -= 90; reasons.push("缺少免钉/免打孔/胀紧规格"); }
    } else if (candidateNoDrill) {
      score -= 60;
      reasons.push("候选含免打孔但订单未要求");
    }
    if (parsed.crafts.includes("打孔")) {
      if (/(?<!免)打孔|螺丝安装/.test(text)) { score += 35; reasons.push("打孔规格匹配"); }
      else { score -= 35; reasons.push("打孔规格不匹配"); }
    }
    for (const finish of ["亮光", "哑光"]) {
      if (!parsed.crafts.includes(finish)) continue;
      if (text.includes(finish)) { score += 25; reasons.push(`${finish}匹配`); }
      else if (finish === "亮光" ? /哑光|亚光/.test(text) : /亮光/.test(text)) score -= 40;
    }
    const color = parsed.colors[0] || "";
    if (color) {
      if (text.includes(color)) { score += 25; reasons.push(`${color}匹配`); }
      else if (/白色|黑色|灰色|银色|奶油色/.test(text)) score -= 30;
    }
    const catalogSpecification = String(authoritativeCatalog?.specification || "").trim();
    const catalogColor = String(authoritativeCatalog?.color || "").trim();
    const compactCandidateText = text.replace(/\s+/g, "");
    if (catalogSpecification) {
      if (text.includes(catalogSpecification)) { score += 140; reasons.push(`权威规格${catalogSpecification}精确匹配`); }
      else { score -= 100; reasons.push(`不符合权威规格${catalogSpecification}`); }
    }
    if (catalogColor) {
      if (compactCandidateText.includes(catalogColor.replace(/\s+/g, ""))) { score += 140; reasons.push(`权威颜色${catalogColor}精确匹配`); }
      else if (/帘罩款|简约款|膨紧款/.test(catalogColor)) { score -= 100; reasons.push(`不符合权威款式${catalogColor}`); }
    }
    const wantsHood = /帘罩款|带帘罩|带罩/.test(parsed.rawText || "");
    if (wantsHood) {
      if (/帘罩款/.test(text)) { score += 100; reasons.push("订单帘罩款匹配"); }
      else { score -= 120; reasons.push("订单要求帘罩款但候选不是帘罩款"); }
    }
    scoredRows.push({ row, text, score, reasons });
  }
  scoredRows.sort((a, b) => b.score - a.score);
  const best = scoredRows[0];
  if (!best || best.score < 50) throw new Error(`未找到与规格匹配的物料：${searchText}`);
  if (scoredRows[1] && scoredRows[1].score === best.score) {
    throw new Error(`候选物料匹配分数并列，需要人工确认：${best.text} / ${scoredRows[1].text}`);
  }
  const chosenText = best.text;
  console.log(`物料匹配依据：${best.reasons.join("；")}（${best.score}分）`);
  if (beforeStep) await beforeStep(6, "弹窗选品", `将勾选权威目录候选：${chosenText}\n匹配依据：${best.reasons.join("；")}`);
  const checkbox = best.row.locator("input[type='checkbox']").first();
  await checkbox.check();
  await modal.getByText("单选", { exact: true }).click();
  await search.waitFor({ state: "hidden", timeout: 15000 }).catch(() => { });
  const targetValues = await targetDetailRow.locator("input,textarea,select").evaluateAll((nodes) => nodes.map((node) => node.value || "").join(" ")).catch(() => "");
  const targetSnapshot = `${await targetDetailRow.innerText().catch(() => "")} ${targetValues}`.replace(/\s+/g, "");
  if (!targetSnapshot.includes(parsed.productCode) || (modelCode && !targetSnapshot.includes(modelCode))) {
    throw new Error(`物料没有写入第 ${rowNumber}/${totalRows} 条目标行，禁止继续填写尺寸`);
  }
  logStep(6, 11, "弹窗选品", `弹窗中锁定并勾选最佳品: [${chosenText}] (得分: ${best.score}，匹配依据: ${best.reasons.join("；")})，已点击“单选”确定关闭弹窗`);
  return { chosenText, detailRow: targetDetailRow };
}

async function fillAndSaveDetail(page, parsed, resolvedMaterial = null, beforeStep = null, detailRow = null, rowNumber = 1, totalRows = 1, targetDetailRow = null) {
  const saveTexts = page.getByText("保存", { exact: true });
  const count = await saveTexts.count();
  let row = targetDetailRow && await targetDetailRow.isVisible().catch(() => false) ? targetDetailRow : null;
  const editableRows = [];
  for (let index = 0; !row && index < count; index += 1) {
    const candidate = saveTexts.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const candidateRow = candidate.locator("xpath=ancestor::tr[1]");
    if (await candidateRow.locator("input").count()) {
      editableRows.push(candidateRow);
    }
  }
  if (!row) row = editableRows[rowNumber - 1] || null;
  if (!row) throw new Error("物料选择后未找到可编辑的明细行");
  const table = row.locator("xpath=ancestor::table[1]");
  const headers = await table.locator("thead th").allInnerTexts();
  const cells = row.locator("td");
  const rowSave = row.getByText("保存", { exact: true });
  const operationCellIndex = await rowSave.locator("xpath=ancestor::td[1]").evaluate((cell) =>
    [...cell.parentElement.children].indexOf(cell)
  ).catch(() => -1);
  let itemCellIndex = -1;
  const cellCount = await cells.count();
  for (let index = 0; index < cellCount; index += 1) {
    const inputs = cells.nth(index).locator("input,textarea,select");
    if (!(await inputs.count())) continue;
    const value = await inputs.first().inputValue().catch(() => "");
    if (/百叶帘|柔纱帘|卷帘|蜂巢帘|香格里拉帘|窗帘/.test(value)) {
      itemCellIndex = index;
      break;
    }
  }
  async function fillColumn(label, value, required = true) {
    let index = headers.findIndex((header) => header.replace(/\s+/g, "").includes(label));
    if (index < 0 && itemCellIndex >= 0) {
      const offsets = { "宽度": 5, "高度": 6, "件数": 7, "数量": 8, "备注": 11 };
      if (Object.prototype.hasOwnProperty.call(offsets, label)) index = itemCellIndex + offsets[label];
    }
    if (index < 0 && operationCellIndex >= 0) {
      const offsetsFromOperation = { "宽度": -7, "高度": -6, "件数": -5, "数量": -4, "备注": -1 };
      if (Object.prototype.hasOwnProperty.call(offsetsFromOperation, label)) index = operationCellIndex + offsetsFromOperation[label];
    }
    if (index < 0) {
      if (required) throw new Error(`明细表未找到“${label}”列`);
      return null;
    }
    const input = cells.nth(index).locator("input,textarea,select").first();
    if (!(await input.count())) {
      if (required) throw new Error(`明细表“${label}”列没有输入框`);
      return null;
    }
    await input.fill(String(value ?? ""));
    return input;
  }
  const effectiveRow = detailRow || buildDetailRows(parsed, resolvedMaterial)[0] || {};
  const detailRemark = effectiveRow.remark || "";
  const rowLabel = totalRows > 1 ? `第 ${rowNumber}/${totalRows} 条明细` : "当前明细";
  if (beforeStep) await beforeStep(7, "明细填写", `${rowLabel}\n宽度：${effectiveRow.width}m\n高度：${effectiveRow.height}m\n件数：${effectiveRow.quantity || 1}\n备注：${detailRemark || "无"}`);
  const widthInput = await fillColumn("宽度", effectiveRow.width);
  const heightInput = await fillColumn("高度", effectiveRow.height);
  const quantityInput = await fillColumn("件数", effectiveRow.quantity || 1, false);
  const remarkInput = await fillColumn("备注", detailRemark, false);
  const actualWidth = await widthInput.inputValue();
  const actualHeight = await heightInput.inputValue();
  const actualQuantity = quantityInput ? await quantityInput.inputValue() : String(effectiveRow.quantity || 1);
  const actualRemark = remarkInput ? await remarkInput.inputValue() : detailRemark;
  if (Number(actualWidth) !== Number(effectiveRow.width) || Number(actualHeight) !== Number(effectiveRow.height)
    || Number(actualQuantity || 1) !== Number(effectiveRow.quantity || 1) || String(actualRemark || "").trim() !== detailRemark) {
    throw new Error(`第 ${rowNumber}/${totalRows} 条明细写入复核失败，禁止保存`);
  }
  logStep(7, 11, "明细填写", `${rowLabel}参数填入完成 -> 宽度: ${effectiveRow.width}m | 高度: ${effectiveRow.height}m | 件数: ${effectiveRow.quantity || 1} | 备注: "${detailRemark}"`);
  if (beforeStep) await beforeStep(8, "橙色保存", `保存${rowLabel}；保存成功后${rowNumber < totalRows ? "继续录入下一条明细" : "才进入最后的自动就绪步骤"}。`);
  const saveResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.ok() && response.url().startsWith(new URL(page.url()).origin),
  { timeout: 3500 }).then(() => "服务器已响应").catch(() => null);
  await rowSave.click();
  // 保存成功信号一出现就继续；旧逻辑无论系统是否已经保存，都可能空等整整 8 秒。
  const saveSignal = await Promise.race([
    rowSave.waitFor({ state: "hidden", timeout: 3500 }).then(() => "保存按钮已隐藏").catch(() => null),
    row.locator("button, a, span").filter({ hasText: /修改|编辑/ }).first().waitFor({ state: "visible", timeout: 3500 }).then(() => "明细行已转为编辑状态").catch(() => null),
    saveResponse,
    page.waitForTimeout(3500).then(() => "快速校验超时")
  ]);
  await page.waitForTimeout(150);

  // 核验页面上无错误阻塞提示
  const errorDialog = page.locator(".layui-layer-dialog, .modal, .alert-danger").filter({ hasText: /错误|失败|必填|超长|不能为/ }).first();
  if (await errorDialog.isVisible().catch(() => false)) {
    const errMsg = await errorDialog.innerText().catch(() => "明细保存失败");
    throw new Error(`报价单明细保存被系统拦截：${errMsg}`);
  }
  logStep(8, 11, "橙色保存", `${rowLabel}已点击橙色“保存”，快速校验结果：${saveSignal}`);
}

// 单帧扫描：来源 0 定位单号单元格向上取最近行（最高精度）；来源 1 逐行扫描 tr/role=row；来源 2 按行号 zip 拼接各 table
async function scanFrame(frame, acceptRow) {
  // 来源 0：文本恰好是 7 位单号的单元格 -> 最近的 role=row/tr 祖先（绕开行组嵌套混淆）
  const idCells = frame.locator("[role='gridcell'], td, th, div, span").filter({ hasText: /^\d{7}$/ });
  const cellCount = Math.min(await idCells.count().catch(() => 0), 80);
  for (let i = 0; i < cellCount; i += 1) {
    const cell = idCells.nth(i);
    const cellText = ((await cell.innerText().catch(() => "")) || "").trim();
    if (!/^\d{7}$/.test(cellText)) continue;
    const row = cell.locator("xpath=ancestor::*[@role='row'][1] | xpath=ancestor::tr[1]").first();
    acceptRow(await row.innerText().catch(() => ""));
  }
  // 来源 1：逐行扫描（aria 网格 role=row / 原生 tr）
  const rows = frame.locator("tr, [role='row']");
  const rowCount = Math.min(await rows.count().catch(() => 0), 200);
  for (let i = 0; i < rowCount; i += 1) {
    acceptRow(await rows.nth(i).innerText().catch(() => ""));
  }
  const tables = frame.locator("table");
  const tableCount = Math.min(await tables.count().catch(() => 0), 12);
  const columnTexts = [];
  let maxRows = 0;
  for (let t = 0; t < tableCount; t += 1) {
    const trs = tables.nth(t).locator("tr");
    const count = Math.min(await trs.count().catch(() => 0), 100);
    const texts = [];
    for (let i = 0; i < count; i += 1) {
      texts.push(((await trs.nth(i).innerText().catch(() => "")) || "").trim());
    }
    columnTexts.push(texts);
    if (texts.length > maxRows) maxRows = texts.length;
  }
  for (let i = 0; i < maxRows; i += 1) {
    acceptRow(columnTexts.map((col) => col[i] || "").filter(Boolean).join(" "));
  }
}

// 从当前聚水潭列表页 DOM 直接读取全部订单行（网络缓存为空时的兜底数据源）
// 该 ERP 网格为 aria div 网格（role=row），且可能存在固定列拆分/行组嵌套：
// 来源 1 逐行扫描 tr/role=row；来源 2 按行号 zip 拼接各 table。
// 行文本混入多个单号时（行组嵌套）标记为低精度，优先保留只含单一单号的文本。
async function readPageOrderRows(page) {
  const seen = new Map();
  let idRowCount = 0;
  let structuredRowCount = 0;
  const MARKER = /宽|米|已付款|待审核|旗舰店|天猫|淘宝|京东|拼多多|预售|异常|等待|详/;
  const put = (orderId, text, multi) => {
    if (!MARKER.test(text) && text.length < 60) return;
    const prev = seen.get(orderId);
    if (!prev || (prev.multi && !multi) || (prev.multi === multi && text.length > prev.text.length)) {
      seen.set(orderId, { text, multi });
    }
  };
  const acceptRow = (rawText) => {
    const text = String(rawText || "").trim();
    const idMatches = [...text.matchAll(/\b\d{7}\b/g)];
    if (!idMatches.length) return;
    idRowCount += 1;
    if (idMatches.length === 1) {
      put(idMatches[0][0], text, false);
      return;
    }
    // 多单号混合文本（行组/巨型容器嵌套）：按单号出现位置切分——DOM 顺序即订单顺序，
    // 每个单号到下一个单号之间的文字属于这一单；固定列克隆导致的同单号二次出现，
    // 会自然把该单内容归入后一个切片（前一切片过短被特征过滤丢弃）
    for (let k = 0; k < idMatches.length; k += 1) {
      const start = idMatches[k].index;
      const end = k + 1 < idMatches.length ? idMatches[k + 1].index : text.length;
      put(idMatches[k][0], text.slice(start, end).trim(), true);
    }
  };

  // 聚水潭旧订单页使用自定义 JTable。每笔订单都在独立的 ._jt_row 中，
  // 单元格通过 data-id 标识；商品完整规格保存在 data-id="its" 内部节点的 title 属性中。
  // 直接读取这些结构化字段，避免横向不可见列、固定列克隆和巨型容器造成串单。
  const scanStructuredRows = async (frame) => {
    const rows = await frame.evaluate(() => [...document.querySelectorAll("._jt_row")].map((row) => {
      const textOf = (id) => (row.querySelector(`[data-id="${id}"]`)?.innerText || "").trim();
      // 合并订单会在同一单元格附加“合”等徽标文本，例如“2630691\n合”。
      // 内部单号仍是开头的 7 位数字，不能因为状态徽标而漏掉整笔订单。
      const orderId = textOf("o_id").match(/^\s*(\d{7})/)?.[1] || "";
      if (!orderId) return null;

      const itemCell = row.querySelector('[data-id="its"]');
      const items = itemCell ? [...itemCell.querySelectorAll("[title]")].map((item) => {
        const title = (item.getAttribute("title") || "").trim();
        const qty = (item.querySelector(".sku_qty")?.textContent || "").trim();
        return [title, qty ? `数量:${qty}` : ""].filter(Boolean).join(" ");
      }).filter(Boolean) : [];

      const parts = [
        orderId,
        textOf("labels"),
        textOf("remark"),
        textOf("buyer_message"),
        textOf("shop_buyer_id"),
        textOf("paid_amount") ? `已付金额: ${textOf("paid_amount")}` : "",
        textOf("status"),
        ...items
      ].filter(Boolean);
      return { orderId, combinedText: parts.join(" "), productEvidence: items.join(" | "), productItemCount: items.length };
    }).filter(Boolean)).catch(() => []);

    for (const row of rows) {
      structuredRowCount += 1;
      seen.set(row.orderId, { text: row.combinedText, productEvidence: row.productEvidence, productItemCount: row.productItemCount, multi: false, structured: true });
    }
  };

  for (const frame of page.frames()) {
    await scanStructuredRows(frame);
  }
  // 聚水潭 JTable 已提供独立结构化订单行时，不再遍历数 MB 的巨型 DOM。
  // 旧版兼容扫描只在完全读不到结构化行时启用。
  if (structuredRowCount === 0) {
    for (const frame of page.frames()) await scanFrame(frame, acceptRow);
  }

  // 虚拟滚动列表只渲染可视行：持续向下滚动，直到真正到底，不设置订单数量上限。
  // 轮次上限只是防止页面脚本异常导致死循环，并不限制订单数量。
  let stagnantRounds = 0;
  for (let round = 0; round < 10000; round += 1) {
    const beforeCount = seen.size;
    let moved = false;
    for (const frame of page.frames()) {
      const frameMoved = await frame.evaluate(() => {
        const jtableBody = document.querySelector("#_jt_body");
        const grids = jtableBody
          ? [jtableBody]
          : [...document.querySelectorAll("div, section, main")]
            .filter((el) => el.scrollHeight > el.clientHeight + 100 && el.clientHeight > 200 && el.querySelector("[role='row'], tr, ._jt_row"));
        if (!grids.length) return false;
        const grid = grids.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
        const before = grid.scrollTop;
        grid.scrollTop = before + grid.clientHeight * 0.9;
        return grid.scrollTop !== before;
      }).catch(() => false);
      if (frameMoved) moved = true;
    }
    if (!moved) break;
    await page.waitForTimeout(400);
    for (const frame of page.frames()) {
      await scanStructuredRows(frame);
      if (structuredRowCount === 0) await scanFrame(frame, acceptRow);
    }
    if (seen.size === beforeCount) stagnantRounds += 1;
    else stagnantRounds = 0;
    if (seen.size > 0 && seen.size % 100 === 0 && seen.size !== beforeCount) {
      console.log(`[全部扫描] 已收集 ${seen.size} 笔订单，继续向下...`);
    }
    if (stagnantRounds >= 5) break;
  }
  const orders = [...seen.entries()].map(([orderId, entry]) => ({
    orderId,
    combinedText: entry.text,
    productEvidence: entry.productEvidence || "",
    productItemCount: entry.productItemCount || 0,
    multi: entry.multi
  }));
  // 扫描结束后把列表滚回顶部，避免用户回来时页面停在底部
  for (const frame of page.frames()) {
    await frame.evaluate(() => {
      const jtableBody = document.querySelector("#_jt_body");
      const grids = jtableBody
        ? [jtableBody]
        : [...document.querySelectorAll("div, section, main")]
          .filter((el) => el.scrollHeight > el.clientHeight + 100 && el.clientHeight > 200 && el.querySelector("[role='row'], tr, ._jt_row"));
      for (const grid of grids) grid.scrollTop = 0;
    }).catch(() => { });
  }
  console.log(`DOM 扫描：结构化订单行 ${structuredRowCount} 条，兼容扫描含单号行 ${idRowCount} 条，最终订单 ${orders.length} 条（其中边界切分兜底 ${orders.filter((o) => o.multi).length} 条，已自动滚动加载虚拟列表）`);
  return orders;
}

async function testAllCachedOrders(page, requestedLimit = null) {
  const now = Date.now();
  let entries = [];
  let source = "当前查询池 DOM";
  if (page) {
    console.log("正在自动向下扫描当前查询池全部订单...");
    entries = await readPageOrderRows(page);
  }
  if (!entries.length) {
    entries = [...orderNetworkCache.values()]
      .filter((entry) => now - (entry.timestamp || 0) <= ORDER_CACHE_TTL)
      .sort((a, b) => b.timestamp - a.timestamp);
    source = "网络拦截缓存（DOM无结果兜底）";
  }
  if (!entries.length) {
    console.log("当前列表页未读到任何订单行：请确认聚水潭订单列表已打开且有数据；也可以按 F5 刷新列表页（让网络拦截缓存生效）后再执行 tryall。");
    console.log("READY_FOR_NEXT_ORDER");
    return;
  }
  const numericLimit = Number(requestedLimit);
  const batch = Number.isFinite(numericLimit) && numericLimit > 0 ? entries.slice(0, Math.floor(numericLimit)) : entries;
  console.log("\n======================== 整页批量测试（只读，不写任何数据） ========================");
  console.log(`数据来源: ${source} | 订单 ${entries.length} 笔，本次测试最新 ${batch.length} 笔（纯本地核对权威目录）...`);
  console.log(`文本抽样 [${batch[0].orderId}]: ${String(batch[0].combinedText || "").replace(/\s+/g, " ").slice(0, 150)}`);
  const summary = { unique: 0, multiple: 0, none: 0, copied: 0, ready: 0 };
  let blocked = 0;
  let index = 0;
  for (const entry of batch) {
    index += 1;
    const text = entry.combinedText;
    // 已抄单（备注已含“已抄”）是历史已处理订单，不再重复测试
    if (/已抄/.test(text)) {
      summary.copied += 1;
      console.log(`[${index}/${batch.length}] ${entry.orderId} | 已抄 | 备注已含“已抄”，本单此前已处理，跳过`);
      continue;
    }
    const parsed = parseOrderText(text);
    const ruleResolved = resolveMaterialText(parsed, mappings.materials);
    const catalogMatch = matchSelectionCatalogFromText({ productCode: parsed.productCode, rawText: text, crafts: parsed.crafts }, selectionCatalog);
    const blockers = [...new Set([
      ...processedOrderBlockers(text),
      ...parsed.issues,
      ...(catalogMatch.status !== "unique" ? [catalogMatch.status === "multiple" ? "权威目录多候选" : "权威目录无结果"] : []),
      ...(entry.productItemCount > 1 ? [`多商品合并单（${entry.productItemCount}项）`] : []),
      ...(isMultiPieceOrder(parsed) ? ["一单多件或多组尺寸"] : [])
    ])];
    summary[catalogMatch.status] = (summary[catalogMatch.status] || 0) + 1;
    if (blockers.length) blocked += 1;
    else summary.ready += 1;
    const finalStatus = blockers.length ? "❌ 不可抄" : "✅ 可抄";
    const catalogStatus = catalogMatch.status === "unique"
      ? `✅ ${catalogMatch.match?.id || "唯一命中"}`
      : catalogMatch.status === "multiple" ? "⚠️ 多候选" : "❌ 无结果";
    const evidence = String(entry.productEvidence || "未读取到商品列原文").replace(/\s+/g, " ").slice(0, 220);
    console.log(`[${index}/${batch.length}] ${entry.orderId} | ${finalStatus} | 商品原文: ${evidence} | 解析款号: ${parsed.productCode || "?"} | 权威目录: ${catalogStatus}${blockers.length ? ` | 原因: ${blockers.join("；")}` : ""}`);
  }
  console.log("================================================================================");
  console.log(`汇总: ✅ 可抄 ${summary.ready} | ❌ 不可抄 ${blocked} | 已抄 ${summary.copied} | 目录唯一 ${summary.unique || 0} | 多候选 ${summary.multiple || 0} | 无结果 ${summary.none || 0}`);
  console.log("说明：必须同时满足“权威目录唯一命中 + 订单关键参数完整”才允许自动录入。");
  console.log("READY_FOR_NEXT_ORDER");
}

function resolveInstalledBrowser() {
  const configured = String(config.browserExecutable || "").trim();
  const candidates = [
    configured,
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) {
    throw new Error("未找到 Microsoft Edge 或 Google Chrome。请先安装任意一个浏览器；无需运行 npx playwright install msedge。也可在 config.json 中设置 browserExecutable 为浏览器完整路径。");
  }
  return executablePath;
}

async function main() {
  const executablePath = resolveInstalledBrowser();
  console.log(`使用浏览器：${executablePath}`);
  context = await chromium.launchPersistentContext(path.resolve(root, config.userDataDir), { executablePath, headless: config.headless, viewport: null, args: ["--remote-debugging-port=9222"] });
  setupNetworkInterception(context);
  await setupOrderClickTracking(context);
  startCheckedOrderMonitor(context);
  await Promise.all([
    openConfiguredPage(config.erpUrlPattern, config.erpUrl, "聚水潭"),
    openConfiguredPage(config.quoteUrlPattern, config.quoteUrl, "报价单")
  ]);
  const blank = context.pages().find((page) => page.url() === "about:blank");
  if (blank && context.pages().length > 2) await blank.close().catch(() => { });
  console.log("两个页面已打开。请完成登录，并在聚水潭中选中一笔订单。");
  console.log("指令说明：run [单号] = 正式录入 | resume [单号] = 从未完成断点继续 | try [单号] = 预览模式（只读取+解析+校验，打印将填写的内容，绝不填单） | tryall = 扫描当前查询池全部订单（只读） | tryall [数量] = 限量测试 | close = 退出");
  console.log("AUTOMATION_READY");
  while (true) {
    const rawLine = await waitForOperation();
    if (!rawLine) continue;
    const command = rawLine.toUpperCase();
    if (command === "CLOSE") break;
    const tryAllMatch = rawLine.match(/^(?:TRY\s*ALL|TRYALL)(?:\s+(\d+))?$/i);
    if (tryAllMatch) {
      const erpPage = context.pages().find((p) => p.url().includes(config.erpUrlPattern)) || null;
      const requestedLimit = tryAllMatch[1] ? Number(tryAllMatch[1]) : null;
      await testAllCachedOrders(erpPage, requestedLimit).catch((error) => {
        console.error(`整页测试失败：${error.message}`);
        console.log("READY_FOR_NEXT_ORDER");
      });
      continue;
    }
    const cmdMatch = rawLine.match(/^(RUN|TRY|RESUME)(?:\s+(\d+))?$/i);
    if (!cmdMatch) continue;
    const previewOnly = cmdMatch[1].toUpperCase() === "TRY";
    const resumeOnly = cmdMatch[1].toUpperCase() === "RESUME";
    const specifiedOrderId = cmdMatch[2] || null;
    try {
      const erp = context.pages().find((page) => page.url().includes(config.erpUrlPattern));
      const quote = context.pages().find((page) => page.url().includes(config.quoteUrlPattern));
      if (!erp || (!previewOnly && !quote)) throw new Error(previewOnly ? "未找到聚水潭页面" : "未同时找到聚水潭和报价单页面");
      if (previewOnly) console.log("[预览模式] 仅执行订单读取、原词提取与权威目录校验，不会触碰报价单与聚水潭的任何数据。");
      const selectedOrder = await readSelectedOrderText(erp, specifiedOrderId);
      const text = selectedOrder.text;
      if (!text) throw new Error("未识别到选中订单：请单击订单所在的整行，或勾选该行左侧复选框后重试");
      const parsed = parseOrderText(text);
      const orderId = selectedOrder.orderId || text.match(/\b\d{6,}\b/)?.[0] || null;
      const pendingAtStart = fs.existsSync(pendingMarkPath) ? JSON.parse(fs.readFileSync(pendingMarkPath, "utf8")) : null;
      const isValidResume = resumeOnly && pendingAtStart?.orderId === orderId;
      if (resumeOnly && !isValidResume) throw new Error(`订单 ${orderId || "未识别"} 没有可继续的断点记录`);
      const amount = parseAmount(text);
      const browserPreconfirmed = browserConfirmedOrders.delete(String(orderId));
      const executionStartedAt = Date.now();
      if (!previewOnly && !currentAuditContext) {
        const batchId = createBatchId();
        auditStore.createBatch({ batchId, mode: "single", orders: [{ orderId, amount }] });
        currentAuditContext = { batchId, orderId };
        auditStore.startOrder(batchId, orderId, { amount, mode: "single" });
      }
      const linePlans = buildOrderLinePlans(text, selectionCatalog, mappings.materials);
      const allCatalogUnique = linePlans.length > 0 && linePlans.every((plan) => plan.catalogMatch.status === "unique" && plan.resolvedMaterial);
      // 单值仅兼容既有日志；每条报价明细实际使用所属规格段的权威目录。
      const catalogMatch = linePlans[0]?.catalogMatch || { status: "none", candidates: [] };
      const resolvedMaterial = linePlans[0]?.resolvedMaterial || null;
      const ruleResolved = resolveMaterialText(parsed, mappings.materials);
      let rows = linePlans.flatMap((plan) => plan.rows);
      if (!previewOnly && currentAuditContext) auditStore.event({ ...currentAuditContext, step: "order-snapshot", phase: "captured", payload: {
        rawText: text,
        sellerMemo: selectedOrder.sellerMemo || "",
        amount,
        parsed,
        linePlans: linePlans.map((plan) => ({ segment: plan.segment, catalogStatus: plan.catalogMatch.status, catalog: plan.catalogMatch.match || null, selection: plan.resolvedMaterial?.outputText || "", rows: plan.rows }))
      } });
      if (!previewOnly) console.log(`[订单准备] ${orderId} | ¥${amount} | ${resolvedMaterial?.outputText || "未确认"} | ${rows.length}条明细`);

      // 保留提取结果和目录裁决日志，供后续核查与改进提取器。
      const logDecision = (type, extra = {}) => recordDualDecision({
        orderId,
        productCode: parsed.productCode,
        fragment: extractSpecFragment(text, parsed.productCode || ""),
        extracted: catalogMatch.extracted || null,
        catalog: {
          status: catalogMatch.status,
          reason: catalogMatch.reason || "",
          match: catalogMatch.match || null,
          candidates: catalogMatch.candidates || []
        },
        decision: { type, ...extra }
      });

      let detail0 = rows[0] || {};
      let accDesc = [detail0.hoodColor ? `帘罩: ${detail0.hoodColor}` : null, detail0.trackColor ? `轨道: ${detail0.trackColor}` : null].filter(Boolean).join("; ");

      // 核心安全哨兵：终端交互确认卡片
      if (!previewOnly) {
      console.log("\n======================== 待录入订单确认 ========================");
      console.log(`【订单编号】: ${orderId || "未识别"}`);
      console.log(`【成交金额】: ¥${amount || "未识别"}`);
      console.log(`【产品款号】: ${parsed.productCode || "未识别"} | 权威颜色: ${catalogMatch.status === "unique" ? catalogMatch.match.color : "待目录确认"} | 工艺: [${parsed.crafts.join(", ")}]`);
      console.log(`【制作尺寸】: ${parsed.width}m × ${parsed.height}m (共 ${parsed.quantity} 件)`);
      console.log(`【选品搜索词】: ${resolvedMaterial?.outputText || "未确认"}`);
      console.log(`【订单备注】: ${detail0.remark || "无"}`);
      if (accDesc) console.log(`【配件配色】: ${accDesc}`);
      console.log(`【订单原词提取】: 目录颜色: ${catalogMatch.extracted?.color || "无"} | 工艺: [${catalogMatch.extracted?.finishes?.join(", ") || "无"}]`);
      if (catalogMatch.status === "unique") console.log(`【权威目录】: ${catalogMatch.match.id} | ${catalogMatch.match.projectName} | ${catalogMatch.match.specification} | ${catalogMatch.match.color}`);
      else if (catalogMatch.candidates?.length) console.log(`【权威目录候选】: ${catalogMatch.candidates.map((x) => `${x.id}/${x.specification}/${x.color}`).join("；")}`);
      console.log(`【目录校验】: ${catalogMatch.status === "unique" ? "唯一命中，可执行" : catalogMatch.status === "multiple" ? "存在多个候选，已拦截" : "无可靠候选，已拦截"}`);
      console.log("===============================================================");
      }

      if (!previewOnly) {
        if (!allCatalogUnique) {
          const reason = linePlanBlockers(linePlans).join("；") || "订单规格段未全部唯一命中权威目录";
          logDecision("catalog-blocked", { outputText: "" });
          if (activeBatchQueue && currentAuditContext?.batchId === activeBatchQueue.batchId) throw new Error(`执行前复核失败：${reason}`);
          if (currentAuditContext) {
            auditStore.finishOrder(currentAuditContext.batchId, orderId, { status: "blocked", error: reason });
            auditStore.finishBatch(currentAuditContext.batchId, { status: "blocked", summary: { reason } });
            currentAuditContext = null;
          }
          console.log(`已暂停：${reason}。未执行任何录入。`);
          console.log("READY_FOR_NEXT_ORDER");
          continue;
        }
        const confirmInput = browserPreconfirmed ? "Y" : (await input.question("确认执行录入并自动审核？(输入 Y 确认 / 输入 N 取消): ")).trim().toUpperCase();
        if (confirmInput !== "Y") {
          logDecision("cancel");
          if (currentAuditContext) {
            auditStore.finishOrder(currentAuditContext.batchId, orderId, { status: "cancelled", result: { reason: "user_cancelled" } });
            auditStore.finishBatch(currentAuditContext.batchId, { status: "cancelled", summary: { orderId } });
            currentAuditContext = null;
          }
          console.log(`操作已安全取消。未对订单 ${orderId} 执行任何录入或审核操作。`);
          console.log("READY_FOR_NEXT_ORDER");
          continue;
        }
        logDecision("confirm-catalog", { outputText: resolvedMaterial.outputText, catalogId: catalogMatch.match.id });
      }

      // 预览模式：打印将要填写的全部内容清单后直接结束，绝不触碰报价单与聚水潭
      if (previewOnly) {
        logDecision("preview", { outputText: resolvedMaterial?.outputText || "" });
        const previewBlockers = [...processedOrderBlockers(text), ...linePlanBlockers(linePlans), ...(!orderId ? ["未识别订单号"] : []), ...(!amount ? ["未识别成交金额"] : [])];
        console.log("\n================ 订单预览（未执行） ================");
        console.log(`订单: ${orderId || "未识别"} | 金额: ¥${amount || "未识别"}`);
        const authoritativeColor = catalogMatch.status === "unique" ? catalogMatch.match.color : "待目录确认";
        console.log(`商品: ${parsed.productCode || "未识别"} | ${parsed.crafts.join("+") || "无工艺"} | ${authoritativeColor}`);
        console.log(`选品: ${resolvedMaterial?.outputText || "未确认"}`);
        if (catalogMatch.status === "unique") console.log(`目录: ${catalogMatch.match.id} | ${catalogMatch.match.projectName} | ${catalogMatch.match.specification} | ${catalogMatch.match.color}`);
        else if (catalogMatch.candidates?.length) console.log(`目录候选: ${catalogMatch.candidates.map((x) => `${x.id}/${x.specification}/${x.color}`).join("；")}`);
        rows.forEach((r, idx) => {
          console.log(`尺寸${rows.length > 1 ? idx + 1 : ""}: ${r.width}m × ${r.height}m | ${r.quantity}件${r.remark ? ` | 备注: ${r.remark}` : ""}`);
        });
        console.log(`校验: ${catalogMatch.status === "unique" ? "权威目录唯一命中" : catalogMatch.status === "multiple" ? "权威目录存在多个候选" : "权威目录无可靠候选"}`);
        if (previewBlockers.length) console.log(`拦截: ${previewBlockers.join("；")}`);
        else console.log("状态: 可执行；输入 run 正式录入");
        console.log("====================================================");
        console.log("只读预览完成，未修改任何数据。");
        console.log("READY_FOR_NEXT_ORDER");
        continue;
      }

      const processedBlockers = isValidResume
        ? []
        : [...processedOrderBlockers(text), ...processedOrderBlockers(selectedOrder.sellerMemo || "")];
      const blockers = [...new Set([...processedBlockers, ...linePlanBlockers(linePlans), ...(!orderId ? ["未识别订单号"] : []), ...(!amount ? ["未识别成交金额"] : [])])];
      if (blockers.length) {
        const reason = blockers.join("；");
        if (activeBatchQueue && currentAuditContext?.batchId === activeBatchQueue.batchId) throw new Error(`执行前复核失败：${reason}`);
        if (currentAuditContext) {
          auditStore.finishOrder(currentAuditContext.batchId, orderId, { status: "blocked", error: reason });
          auditStore.finishBatch(currentAuditContext.batchId, { status: "blocked", summary: { reason } });
          currentAuditContext = null;
        }
        console.log(`已暂停：${reason}`);
      } else {
        await confirmWorkflowStep(erp, 1, "订单读取", `订单号：${orderId}\n成交金额：¥${amount}\n款号：${parsed.productCode}\n尺寸：${parsed.width}m × ${parsed.height}m\n件数：${parsed.quantity}`);
        logStep(1, 11, "订单读取", `订单号: ${orderId} | 已付金额: ¥${amount} | 款号: ${parsed.productCode} | 颜色: ${parsed.colors.join("/") || "未指定"} | 尺寸: ${parsed.width}m × ${parsed.height}m | 工艺: [${parsed.crafts.join(", ")}]`);

        await confirmWorkflowStep(erp, 2, "目录裁决", `权威目录：${catalogMatch.match.id}\n目标物料：${resolvedMaterial.outputText}\n目录颜色：${catalogMatch.match.color}\n配件配色：${accDesc || "无"}`);
        logStep(2, 11, "目录裁决", `目标物料: ${resolvedMaterial.outputText} | 目录状态: 唯一命中 | 配件配色: [${accDesc || "无"}] | 最终备注: "${detail0.remark || ""}"`);
        console.log(`>>> [本地原词提取] 目录颜色: ${catalogMatch.extracted?.color || "无"} | 工艺: [${catalogMatch.extracted?.finishes?.join(", ") || "无"}]`);

        let pendingMark = fs.existsSync(pendingMarkPath) ? JSON.parse(fs.readFileSync(pendingMarkPath, "utf8")) : null;
        if (!pendingMark || pendingMark.orderId !== orderId) {
          pendingMark = { orderId, voucher: "", quoteSuccess: false, detailRowsCompleted: 0, remarkSuccess: false, auditSuccess: false, createdAt: new Date().toISOString() };
          fs.writeFileSync(pendingMarkPath, JSON.stringify(pendingMark, null, 2), "utf8");
        } else {
          console.log(`检测到订单 ${orderId} 的断点记录，将从尚未完成的步骤继续。`);
        }

        const persistPendingMark = () => fs.writeFileSync(pendingMarkPath, JSON.stringify(pendingMark, null, 2), "utf8");
        const parallelStartedAt = Date.now();

        const runErpChain = async () => {
          const chainStartedAt = Date.now();
          console.log(`[并行流程] ERP链启动：订单 ${orderId}`);
          if (!pendingMark.remarkSuccess) {
            const confirmStartedAt = browserConfirmStartedAt.get(String(orderId));
            if (confirmStartedAt) console.log(`[确认耗时] 点击确认 → 开始ERP备注回写：${Date.now() - confirmStartedAt}ms`);
            await confirmWorkflowStep(erp, 9, "ERP回写", `将在订单 ${orderId} 的卖家备注前追加“已抄”。`);
            await withHumanTakeover(erp, "ERP备注回写", () => prependCopiedRemark(erp, { confirm: true, targetOrderId: orderId, selectedCheckbox: selectedOrder.checkbox, selectedFrame: selectedOrder.frame, selectionVerifiedAt: selectedOrder.selectionVerifiedAt, originalSellerMemo: selectedOrder.sellerMemo }));
            if (confirmStartedAt) console.log(`[确认耗时] 点击确认 → 服务器确认“已抄”成功：${Date.now() - confirmStartedAt}ms`);
            browserConfirmStartedAt.delete(String(orderId));
            pendingMark.remarkSuccess = true;
            persistPendingMark();
          }
          if (!pendingMark.auditSuccess) {
            await confirmWorkflowStep(erp, 10, "ERP审核", `将审核订单 ${orderId}，订单状态预计变更为“发货中”。`);
            await withHumanTakeover(erp, "ERP审核", () => auditSelectedOrder(erp, { confirm: true, targetOrderId: orderId, selectedCheckbox: selectedOrder.checkbox, selectedFrame: selectedOrder.frame }));
            pendingMark.auditSuccess = true;
            persistPendingMark();
          }
          console.log(`[并行耗时] ERP链完成：${Date.now() - chainStartedAt}ms`);
        };

        const runQuoteChain = async () => {
          const chainStartedAt = Date.now();
          console.log(`[并行流程] 报价链启动：订单 ${orderId}`);
          if (!pendingMark.quoteSuccess) {
          let voucher = pendingMark.voucher || "";
          if (voucher) {
            const editUrl = new URL(`/仓库通用异动单据1_XS/Edit/${voucher}`, config.quoteUrl).href;
            await quote.goto(editUrl, { waitUntil: "domcontentloaded" });
            const resumedContact = await quote.locator(config.selectors.quoteContact).inputValue().catch(() => "");
            if (resumedContact.trim() !== String(orderId)) throw new Error(`断点凭证 ${voucher} 的联系人不是订单 ${orderId}，禁止继续`);
            console.log(`[断点续做] 已打开凭证 ${voucher}，从第 ${Number(pendingMark.detailRowsCompleted || 0) + 1} 条明细继续`);
          } else {
            await confirmWorkflowStep(quote, 3, "主表录入", `将强制返回报价单列表并打开“添加”，确认是空白新单后再填写。\n联系人：${orderId}\n成交金额：¥${amount}`);
            await withHumanTakeover(quote, "报价单主表录入", async () => {
              await openQuoteEditPage(quote);
              await quote.locator(config.selectors.quoteContact).fill(orderId);
              await quote.locator(config.selectors.quoteAmount).fill(amount);
            });
            console.log(`[报价单 3.5] 已填写空白新单：联系人 ${orderId} | 成交金额 ¥${amount}`);
            logStep(3, 11, "主表录入", `已从列表进入空白“添加”页，向“联系人”填入订单号: ${orderId}，向“成交金额”填入: ¥${amount}`);
          }
          if (config.dryRun) {
            console.log("报价单主表已填写；dryRun 模式不会继续保存。");
          } else {
            if (!voucher) {
              await confirmWorkflowStep(quote, 4, "主表保存", `保存订单 ${orderId} 的报价单主表并生成凭证编号。`);
              const readManualVoucher = async () => {
                const value = await quote.locator("input[name='凭证编号']").inputValue().catch(() => "");
                const bodyText = await quote.locator("body").innerText().catch(() => "");
                const found = value || bodyText.match(/XS\d{10,}/)?.[0] || "";
                const contact = await quote.locator(config.selectors.quoteContact).inputValue().catch(() => "");
                if (!found || contact.trim() !== String(orderId)) throw new Error("人工保存后未能验证凭证号和联系人，停止本单");
                return found;
              };
              voucher = await withHumanTakeover(quote, "报价单主表保存", () => saveQuoteHeader(quote, { orderId, amount }), readManualVoucher);
              pendingMark.voucher = voucher;
              pendingMark.detailRowsCompleted = Number(pendingMark.detailRowsCompleted || 0);
              persistPendingMark();
              console.log(`[断点记录] 主表凭证 ${voucher} 已立即保存，后续失败不会重复新建报价单`);
            }
            const quoteGate = (step, name, details) => confirmWorkflowStep(quote, step, name, details);
            for (let rowIndex = Number(pendingMark.detailRowsCompleted || 0); rowIndex < rows.length; rowIndex += 1) {
              const currentRow = rows[rowIndex];
              const currentPlan = linePlans[currentRow.linePlanIndex ?? 0];
              const rowPrefix = rows.length > 1 ? `第 ${rowIndex + 1}/${rows.length} 条明细：` : "";
              const materialResult = await withHumanTakeover(quote, `${rowPrefix}物料选择`, () => chooseMaterial(quote, currentPlan.resolvedMaterial.outputText, currentPlan.parsed, currentPlan.catalogMatch.match, (step, name, details) => quoteGate(step, name, `${rowPrefix}${details}`), rowIndex + 1, rows.length));
              await withHumanTakeover(quote, `${rowPrefix}明细填写与保存`, () => fillAndSaveDetail(quote, currentPlan.parsed, currentPlan.resolvedMaterial, quoteGate, currentRow, rowIndex + 1, rows.length, materialResult?.detailRow));
              pendingMark.detailRowsCompleted = rowIndex + 1;
              persistPendingMark();
              console.log(`[断点记录] 已完成报价明细 ${rowIndex + 1}/${rows.length}`);
            }
            pendingMark.quoteSuccess = true;
            persistPendingMark();
          }
          }
          console.log(`[并行耗时] 报价链完成：${Date.now() - chainStartedAt}ms`);
        };

        const chainResults = await Promise.allSettled([runErpChain(), runQuoteChain()]);
        const chainNames = ["ERP链", "报价链"];
        const chainErrors = chainResults
          .map((result, index) => result.status === "rejected" ? `${chainNames[index]}：${result.reason?.message || result.reason}` : "")
          .filter(Boolean);
        console.log(`[并行耗时] 两链汇合：${Date.now() - parallelStartedAt}ms | ERP=${pendingMark.remarkSuccess && pendingMark.auditSuccess ? "成功" : "未完成"} | 报价=${pendingMark.quoteSuccess ? "成功" : "未完成"}`);
        if (chainErrors.length) throw new Error(`并行流程未全部完成：${chainErrors.join("；")}`);

        if (!config.dryRun && pendingMark.remarkSuccess && pendingMark.auditSuccess && pendingMark.quoteSuccess) {
          await confirmWorkflowStep(erp, 11, "自动就绪", `取消订单 ${orderId} 的勾选并结束本单。`);
          await withHumanTakeover(erp, "取消已完成订单勾选", () => uncheckProcessedOrder(selectedOrder.checkbox, erp, orderId, selectedOrder.frame));
          fs.unlinkSync(pendingMarkPath);
          if (currentAuditContext) auditStore.finishOrder(currentAuditContext.batchId, orderId, { status: "completed", voucher: pendingMark.voucher, detailCount: rows.length, durationMs: Date.now() - executionStartedAt, result: { amount, selections: linePlans.map((plan) => plan.resolvedMaterial?.outputText), rows } });
          if (activeBatchQueue && activeBatchQueue.current()?.orderId === String(orderId)) {
            activeBatchQueue.completeCurrent({ voucher: pendingMark.voucher, detailCount: rows.length });
            persistActiveBatch();
            currentAuditContext = null;
            await showBatchProgress(erp);
            await scheduleNextBatchOrder(selectedOrder.frame);
          } else {
            if (currentAuditContext) auditStore.finishBatch(currentAuditContext.batchId, { status: "completed", summary: { orderId, voucher: pendingMark.voucher } });
            currentAuditContext = null;
            await showCompletionNotice(erp, { orderId, voucher: pendingMark.voucher, detailCount: rows.length });
          }
          console.log("============================================================");
          console.log(`✅ 抄单完成 | 订单 ${orderId} | 凭证 ${pendingMark.voucher || "已保存"} | 明细 ${rows.length} 条`);
          console.log("============================================================");
        }
      }
    } catch (error) {
      if (currentAuditContext) {
        const belongsToActiveBatch = Boolean(activeBatchQueue && currentAuditContext.batchId === activeBatchQueue.batchId);
        auditStore.finishOrder(currentAuditContext.batchId, currentAuditContext.orderId, { status: belongsToActiveBatch ? "paused" : "failed", error: error.message });
        if (belongsToActiveBatch) {
          activeBatchQueue.pauseCurrent(error.message);
          persistActiveBatch();
          auditStore.finishBatch(activeBatchQueue.batchId, { status: "paused", summary: { error: error.message, currentOrder: currentAuditContext.orderId } });
          const erpPage = context.pages().find((page) => page.url().includes(config.erpUrlPattern));
          await showBatchProgress(erpPage, { error: error.message });
        } else auditStore.finishBatch(currentAuditContext.batchId, { status: "failed", summary: { error: error.message } });
        currentAuditContext = null;
      }
      if (/用户在步骤.+停止本单|人工接管步骤.+已停止本单/.test(String(error.message || ""))) {
        if (fs.existsSync(pendingMarkPath)) fs.unlinkSync(pendingMarkPath);
        console.log("用户已结束本单：本地断点记录已删除，不再保留续做状态。");
      }
      console.error(`本单未完成：${error.message}`);
    }
    console.log("READY_FOR_NEXT_ORDER");
  }
  await context.close();
  auditStore.close();
  await input.close();
}

main().catch(async (error) => {
  console.error(`自动化停止：${error.message}`);
  if (context) {
    await context.close().catch(() => { });
  }
  input.close();
  process.exitCode = 1;
});
