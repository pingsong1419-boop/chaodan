import fs from "node:fs";
import path from "node:path";
const file = path.resolve(import.meta.dirname, "../src/index.js");
let s = fs.readFileSync(file, "utf8");
function once(from, to, label) {
  if (!s.includes(from)) throw new Error(`missing ${label}`);
  s = s.replace(from, to);
}

once("  const listenerVersion = 6;", "  const listenerVersion = 7;", "listener version");
once(
`  window.__codexUpdateBatchTray = () => {
    const toggle = document.getElementById("codex-batch-mode-toggle");`,
`  window.__codexUpdateBatchTray = () => {
    if (!location.href.includes("/app/order/order/list.aspx")) { document.getElementById("codex-batch-tray")?.remove(); return; }
    const toggle = document.getElementById("codex-batch-mode-toggle");`,
  "tray frame guard"
);
once(
`  const mountBatchToggle = () => {
    if (!document.body || document.getElementById("codex-batch-mode-toggle")) return;`,
`  const mountBatchToggle = () => {
    if (!location.href.includes("/app/order/order/list.aspx")) return;
    if (!document.body || document.getElementById("codex-batch-mode-toggle")) return;`,
  "toggle frame guard"
);
once(
`    toggle.onclick = () => {
      window.__codexBatchCollectionMode = !window.__codexBatchCollectionMode;
      document.getElementById("codex-order-confirm")?.remove();`,
`    toggle.onclick = async () => {
      const enabled = !window.__codexBatchCollectionMode;
      if (typeof window.__codexSetBatchCollectionMode === "function") await window.__codexSetBatchCollectionMode(enabled);
      else window.__codexBatchCollectionMode = enabled;
      document.getElementById("codex-order-confirm")?.remove();`,
  "toggle global binding"
);
once(
`let lastCheckedOrderChangedAt = 0;`,
`let lastCheckedOrderChangedAt = 0;
let batchCollectionMode = false;

async function syncBatchCollectionMode(enabled) {
  batchCollectionMode = Boolean(enabled);
  if (!context) return;
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      await frame.evaluate((value) => {
        window.__codexBatchCollectionMode = value;
        window.__codexUpdateBatchTray?.();
      }, batchCollectionMode).catch(() => {});
    }
  }
}`, "node batch mode state");

once(
`async function setupOrderClickTracking(browserContext) {
  await browserContext.exposeBinding("__codexRememberOrderClick",`,
`async function setupOrderClickTracking(browserContext) {
  await browserContext.exposeBinding("__codexSetBatchCollectionMode", async (_source, enabled) => {
    await syncBatchCollectionMode(enabled);
    return batchCollectionMode;
  });
  await browserContext.exposeBinding("__codexRememberOrderClick",`,
  "mode binding"
);

once(
`  await browserContext.exposeBinding("__codexConfirmBatch", async (source, infos) => {
    if (activeBatchQueue`,
`  await browserContext.exposeBinding("__codexConfirmBatch", async (source, infos) => {
    await syncBatchCollectionMode(false);
    if (activeBatchQueue`,
  "disable mode in node"
);

once(
`      const isCollectingBatch = await found.frame.evaluate(() => Boolean(window.__codexBatchCollectionMode)).catch(() => false);
      if (isCollectingBatch) return;`,
`      if (batchCollectionMode) return;`,
  "monitor global state"
);

fs.writeFileSync(file, s, "utf8");
console.log("fixed continuous mode across ERP frames");
