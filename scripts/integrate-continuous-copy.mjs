import fs from "node:fs";
import path from "node:path";

const file = path.resolve(import.meta.dirname, "../src/index.js");
let s = fs.readFileSync(file, "utf8");
function once(from, to, label) {
  if (!s.includes(from)) throw new Error(`missing ${label}`);
  s = s.replace(from, to);
}

once(
  'import { buildOrderLinePlans, linePlanBlockers } from "./order-line-plans.js";',
  'import { buildOrderLinePlans, linePlanBlockers } from "./order-line-plans.js";\nimport { AuditStore } from "./audit-store.js";\nimport { BatchQueue, createBatchId } from "./batch-queue.js";',
  "imports"
);

once(
  'const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");',
  `const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "unknown";
const auditStore = new AuditStore(path.join(root, "data", "audit", "order-automation.db"), { version: packageVersion });`,
  "audit init"
);

once(
  'const savedVoucherOrders = new Map();',
  `const savedVoucherOrders = new Map();
const batchStatePath = path.join(root, "data", "audit", "active-batch.json");
let activeBatchQueue = null;
let currentAuditContext = null;
let lastCheckedOrderChangedAt = 0;`,
  "batch state"
);

once(
  `function logStep(stepIndex, totalSteps, actionName, details = "") {
  const prefix = \`>>> [Step \${stepIndex}/\${totalSteps} \${actionName}]\`;`,
  `function logStep(stepIndex, totalSteps, actionName, details = "") {
  const prefix = \`>>> [Step \${stepIndex}/\${totalSteps} \${actionName}]\`;
  if (currentAuditContext) auditStore.event({ ...currentAuditContext, step: \`step-\${stepIndex}-\${actionName}\`, phase: "success", payload: { details } });`,
  "logStep audit"
);

once(
  `  if (config.confirmEveryStep === false) {
    console.log(\`[连续执行 \${sequence}/11] 步骤 \${stepNumber} \${actionName}：已由订单总确认授权，自动继续\`);`,
  `  if (currentAuditContext) auditStore.event({ ...currentAuditContext, step: \`step-\${stepNumber}-\${actionName}\`, phase: "authorized", executor: "user_confirm", payload: { sequence, details } });
  if (config.confirmEveryStep === false) {
    console.log(\`[连续执行 \${sequence}/11] 步骤 \${stepNumber} \${actionName}：已由订单总确认授权，自动继续\`);`,
  "confirm audit"
);

once(
  `  } catch (error) {
    console.error(\`[自动步骤失败] \${actionName}：\${error.message}\`);
    await requestHumanTakeover(page, actionName, error.message);`,
  `  } catch (error) {
    console.error(\`[自动步骤失败] \${actionName}：\${error.message}\`);
    if (currentAuditContext) auditStore.event({ ...currentAuditContext, step: actionName, phase: "automation_failed", error: error.message });
    await requestHumanTakeover(page, actionName, error.message);
    if (currentAuditContext) auditStore.event({ ...currentAuditContext, step: actionName, phase: "human_completed", executor: "human_takeover" });`,
  "human audit"
);

once(
  `  window.__codexShowCheckedOrderConfirm = async (checkbox) => {
    if (!checkbox || !checkbox.checked) return;`,
  `  window.__codexShowCheckedOrderConfirm = async (checkbox) => {
    if (window.__codexBatchSelecting) return;
    if (!checkbox || !checkbox.checked) return;`,
  "single selection guard"
);

const batchUi = fs.readFileSync(path.resolve(import.meta.dirname, "batchUi.snippet.txt"), "utf8");

once(
  `  document.addEventListener("change", (event) => {
    const checkbox = event.target instanceof HTMLInputElement && event.target.type === "checkbox" ? event.target : null;
    if (checkbox) window.__codexShowCheckedOrderConfirm(checkbox);
  }, true);`,
  `${batchUi}
  let codexSelectionTimer = null;
  document.addEventListener("change", (event) => {
    const checkbox = event.target instanceof HTMLInputElement && event.target.type === "checkbox" ? event.target : null;
    if (!checkbox || window.__codexBatchSelecting) return;
    clearTimeout(codexSelectionTimer);
    codexSelectionTimer = setTimeout(() => {
      const checked = [...document.querySelectorAll("input._jt_cbx:checked")].filter((node) => !node.closest("thead, th"));
      if (checked.length > 1) window.__codexShowBatchConfirm();
      else if (checked.length === 1) window.__codexShowCheckedOrderConfirm(checked[0]);
    }, 900);
  }, true);`,
  "batch UI"
);

once(
  `  await browserContext.exposeBinding("__codexConfirmCheckedOrder", (_source, orderId) => {`,
  `  await browserContext.exposeBinding("__codexConfirmBatch", async (source, infos) => {
    if (activeBatchQueue && !["completed", "paused"].includes(activeBatchQueue.status)) throw new Error("已有连续抄单批次正在执行");
    const orders = Array.isArray(infos) ? infos.filter((info) => info?.ready && /^\\d{7}$/.test(String(info.orderId))) : [];
    if (orders.length < 2 || orders.length !== infos.length) throw new Error("批量预检未全部通过");
    const batchId = createBatchId();
    activeBatchQueue = new BatchQueue({ batchId, orders });
    auditStore.createBatch({ batchId, mode: "continuous", orders, summary: { source: "erp-checkboxes" } });
    persistActiveBatch();
    console.log(\`[连续抄单] 批次 \${batchId} 已建立，共 \${orders.length} 笔，开始按页面序号执行\`);
    await scheduleNextBatchOrder(source.frame);
    return true;
  });
  await browserContext.exposeBinding("__codexConfirmCheckedOrder", (_source, orderId) => {`,
  "batch binding"
);

// Monitor: compute IDs and stable debounce, call batch UI for multiple.
once(
  `          if (count !== 1) {
            found = count > 1 ? { signature: \`multiple:\${count}\`, frame, checkbox: null } : null;
            continue;
          }`,
  `          if (count !== 1) {
            if (count > 1) {
              const orderIds = await checked.evaluateAll((nodes) => nodes.map((node) => node.closest("._jt_row, tr, [role='row']")?.innerText?.match(/\\b\\d{7}\\b/)?.[0] || "").filter(Boolean));
              found = { signature: \`multiple:\${orderIds.join(",")}\`, frame, checkbox: null, orderIds };
            } else found = null;
            continue;
          }`,
  "monitor multiple ids"
);
once(
  `      if (signature === lastCheckedOrderSignature) return;
      lastCheckedOrderSignature = signature;
      if (found.checkbox) {`,
  `      if (activeBatchQueue && ["ready", "running"].includes(activeBatchQueue.status)) return;
      if (signature !== lastCheckedOrderSignature) {
        lastCheckedOrderSignature = signature;
        lastCheckedOrderChangedAt = Date.now();
        return;
      }
      if (Date.now() - lastCheckedOrderChangedAt < 900) return;
      lastCheckedOrderChangedAt = Number.MAX_SAFE_INTEGER;
      if (found.checkbox) {`,
  "monitor debounce"
);
once(
  `      } else {
        console.log(\`[勾选信号] 检测到同时勾选多笔订单，已停止弹出抄单确认。\`);
      }`,
  `      } else {
        console.log(\`[勾选信号] 检测到同时勾选 \${found.orderIds?.length || 0} 笔订单，正在显示连续抄单预检...\`);
        await found.frame.evaluate(() => window.__codexShowBatchConfirm?.());
      }`,
  "monitor batch call"
);

const coordinator = fs.readFileSync(path.resolve(import.meta.dirname, "coordinator.snippet.txt"), "utf8");

once(
  `function startCheckedOrderMonitor(browserContext) {`,
  `${coordinator}
function startCheckedOrderMonitor(browserContext) {`,
  "coordinator"
);

// Single audit context after order id is known.
once(
  `      const amount = parseAmount(text);
      const browserPreconfirmed = browserConfirmedOrders.delete(String(orderId));`,
  `      const amount = parseAmount(text);
      const browserPreconfirmed = browserConfirmedOrders.delete(String(orderId));
      const executionStartedAt = Date.now();
      if (!previewOnly && !currentAuditContext) {
        const batchId = createBatchId();
        auditStore.createBatch({ batchId, mode: "single", orders: [{ orderId, amount }] });
        currentAuditContext = { batchId, orderId };
        auditStore.startOrder(batchId, orderId, { amount, mode: "single" });
      }`,
  "single audit start"
);

// Replace success notice block with batch-aware completion.
once(
  `          await showCompletionNotice(erp, { orderId, voucher: pendingMark.voucher, detailCount: rows.length });
          fs.unlinkSync(pendingMarkPath);
          console.log("============================================================");`,
  `          fs.unlinkSync(pendingMarkPath);
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
          console.log("============================================================");`,
  "success batch advance"
);

// Add audit failure/pause at catch start.
once(
  `    } catch (error) {
      if (/用户在步骤.+停止本单|人工接管步骤.+已停止本单/.test(String(error.message || ""))) {`,
  `    } catch (error) {
      if (currentAuditContext) {
        auditStore.finishOrder(currentAuditContext.batchId, currentAuditContext.orderId, { status: activeBatchQueue ? "paused" : "failed", error: error.message });
        if (activeBatchQueue) {
          activeBatchQueue.pauseCurrent(error.message);
          persistActiveBatch();
          auditStore.finishBatch(activeBatchQueue.batchId, { status: "paused", summary: { error: error.message, currentOrder: currentAuditContext.orderId } });
          const erpPage = context.pages().find((page) => page.url().includes(config.erpUrlPattern));
          await showBatchProgress(erpPage, { error: error.message });
        } else auditStore.finishBatch(currentAuditContext.batchId, { status: "failed", summary: { error: error.message } });
        currentAuditContext = null;
      }
      if (/用户在步骤.+停止本单|人工接管步骤.+已停止本单/.test(String(error.message || ""))) {`,
  "failure audit"
);

// close audit database.
once(
  `  await context.close();
  await input.close();`,
  `  await context.close();
  auditStore.close();
  await input.close();`,
  "audit close"
);

fs.writeFileSync(file, s, "utf8");
console.log("integrated continuous copy and audit backend");
