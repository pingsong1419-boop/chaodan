import fs from "node:fs";
import path from "node:path";
const file = path.resolve(import.meta.dirname, "../src/index.js");
let s = fs.readFileSync(file, "utf8");
function once(from, to, label) {
  if (!s.includes(from)) throw new Error(`missing ${label}`);
  s = s.replace(from, to);
}

once(
`  window.__codexOrderClickInstalled = true;
  document.addEventListener("click", (event) => {`,
`  window.__codexOrderClickInstalled = true;
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
    tray.innerHTML = \`<div style="font-size:17px;font-weight:700">连续抄单选单中</div><div style="margin:8px 0">已选择 <b>\${checked.length}</b> 笔订单</div><div style="display:flex;justify-content:flex-end;gap:8px"><button id="codex-batch-clear">清空</button><button id="codex-batch-preview" \${checked.length >= 2 ? "" : "disabled"} style="background:#1677ff;color:#fff;border:0;border-radius:4px;padding:7px 14px;opacity:\${checked.length >= 2 ? 1 : .45}">开始预检</button></div>\`;
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
  document.addEventListener("click", (event) => {`,
  "batch toggle UI"
);

once(
`    if (!checkbox || window.__codexBatchSelecting) return;
    clearTimeout(codexSelectionTimer);`,
`    if (!checkbox || window.__codexBatchSelecting) return;
    if (window.__codexBatchCollectionMode) { window.__codexUpdateBatchTray(); return; }
    clearTimeout(codexSelectionTimer);`,
  "collection change"
);

once(
`      window.__codexBatchSelecting = false;
      overlay.remove();
      await window.__codexConfirmBatch(infos);`,
`      window.__codexBatchSelecting = false;
      window.__codexBatchCollectionMode = false;
      window.__codexUpdateBatchTray?.();
      overlay.remove();
      await window.__codexConfirmBatch(infos);`,
  "disable collection after start"
);

once(
`      if (activeBatchQueue && ["ready", "running"].includes(activeBatchQueue.status)) return;
      if (signature !== lastCheckedOrderSignature) {`,
`      if (activeBatchQueue && ["ready", "running"].includes(activeBatchQueue.status)) return;
      const isCollectingBatch = await found.frame.evaluate(() => Boolean(window.__codexBatchCollectionMode)).catch(() => false);
      if (isCollectingBatch) return;
      if (signature !== lastCheckedOrderSignature) {`,
  "monitor collection guard"
);

fs.writeFileSync(file, s, "utf8");
console.log("added explicit continuous-copy mode toggle");
