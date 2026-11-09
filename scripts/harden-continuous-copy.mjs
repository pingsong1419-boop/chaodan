import fs from "node:fs";
import path from "node:path";
const file = path.resolve(import.meta.dirname, "../src/index.js");
let s = fs.readFileSync(file, "utf8");
function once(from, to, label) {
  if (!s.includes(from)) throw new Error(`missing ${label}`);
  s = s.replace(from, to);
}

once(
`    persistActiveBatch();
    console.log(\`[连续抄单] 批次 \${batchId} 已建立，共 \${orders.length} 笔，开始按页面序号执行\`);
    await scheduleNextBatchOrder(source.frame);
    return true;`,
`    persistActiveBatch();
    console.log(\`[连续抄单] 批次 \${batchId} 已建立，共 \${orders.length} 笔，开始按页面序号执行\`);
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
    }`,
  "batch start failure"
);

once(
`      let rows = linePlans.flatMap((plan) => plan.rows);
      if (!previewOnly) console.log(\`[订单准备] \${orderId} | ¥\${amount} | \${resolvedMaterial?.outputText || "未确认"} | \${rows.length}条明细\`);`,
`      let rows = linePlans.flatMap((plan) => plan.rows);
      if (!previewOnly && currentAuditContext) auditStore.event({ ...currentAuditContext, step: "order-snapshot", phase: "captured", payload: {
        rawText: text,
        sellerMemo: selectedOrder.sellerMemo || "",
        amount,
        parsed,
        linePlans: linePlans.map((plan) => ({ segment: plan.segment, catalogStatus: plan.catalogMatch.status, catalog: plan.catalogMatch.match || null, selection: plan.resolvedMaterial?.outputText || "", rows: plan.rows }))
      } });
      if (!previewOnly) console.log(\`[订单准备] \${orderId} | ¥\${amount} | \${resolvedMaterial?.outputText || "未确认"} | \${rows.length}条明细\`);`,
  "snapshot audit"
);

once(
`        if (!allCatalogUnique) {
          logDecision("catalog-blocked", { outputText: "" });
          console.log(\`已暂停：\${linePlanBlockers(linePlans).join("；") || "订单规格段未全部唯一命中权威目录"}。未执行任何录入。\`);
          console.log("READY_FOR_NEXT_ORDER");
          continue;
        }`,
`        if (!allCatalogUnique) {
          const reason = linePlanBlockers(linePlans).join("；") || "订单规格段未全部唯一命中权威目录";
          logDecision("catalog-blocked", { outputText: "" });
          if (activeBatchQueue && currentAuditContext?.batchId === activeBatchQueue.batchId) throw new Error(\`执行前复核失败：\${reason}\`);
          if (currentAuditContext) {
            auditStore.finishOrder(currentAuditContext.batchId, orderId, { status: "blocked", error: reason });
            auditStore.finishBatch(currentAuditContext.batchId, { status: "blocked", summary: { reason } });
            currentAuditContext = null;
          }
          console.log(\`已暂停：\${reason}。未执行任何录入。\`);
          console.log("READY_FOR_NEXT_ORDER");
          continue;
        }`,
  "catalog blocked"
);

once(
`        if (confirmInput !== "Y") {
          logDecision("cancel");
          console.log(\`操作已安全取消。未对订单 \${orderId} 执行任何录入或审核操作。\`);`,
`        if (confirmInput !== "Y") {
          logDecision("cancel");
          if (currentAuditContext) {
            auditStore.finishOrder(currentAuditContext.batchId, orderId, { status: "cancelled", result: { reason: "user_cancelled" } });
            auditStore.finishBatch(currentAuditContext.batchId, { status: "cancelled", summary: { orderId } });
            currentAuditContext = null;
          }
          console.log(\`操作已安全取消。未对订单 \${orderId} 执行任何录入或审核操作。\`);`,
  "single cancel audit"
);

once(
`      if (blockers.length) {
        console.log(\`已暂停：\${blockers.join("；")}\`);
      } else {`,
`      if (blockers.length) {
        const reason = blockers.join("；");
        if (activeBatchQueue && currentAuditContext?.batchId === activeBatchQueue.batchId) throw new Error(\`执行前复核失败：\${reason}\`);
        if (currentAuditContext) {
          auditStore.finishOrder(currentAuditContext.batchId, orderId, { status: "blocked", error: reason });
          auditStore.finishBatch(currentAuditContext.batchId, { status: "blocked", summary: { reason } });
          currentAuditContext = null;
        }
        console.log(\`已暂停：\${reason}\`);
      } else {`,
  "runtime blockers"
);

once(
`      if (currentAuditContext) {
        auditStore.finishOrder(currentAuditContext.batchId, currentAuditContext.orderId, { status: activeBatchQueue ? "paused" : "failed", error: error.message });
        if (activeBatchQueue) {`,
`      if (currentAuditContext) {
        const belongsToActiveBatch = Boolean(activeBatchQueue && currentAuditContext.batchId === activeBatchQueue.batchId);
        auditStore.finishOrder(currentAuditContext.batchId, currentAuditContext.orderId, { status: belongsToActiveBatch ? "paused" : "failed", error: error.message });
        if (belongsToActiveBatch) {`,
  "catch ownership"
);

fs.writeFileSync(file, s, "utf8");
console.log("hardened continuous copy failure paths");
