import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(import.meta.dirname, "..");
const filename = path.join(root, "data", "audit", "order-automation.db");
if (!fs.existsSync(filename)) {
  console.error("尚无审计数据库，请先运行并完成至少一次抄单。");
  process.exitCode = 1;
} else {
  const db = new DatabaseSync(filename, { readOnly: true });
  const query = String(process.argv[2] || "").trim();
  let batches;
  if (/^B\d/.test(query)) {
    batches = db.prepare("SELECT * FROM batches WHERE batch_id=?").all(query);
  } else if (/^\d{6,12}$/.test(query)) {
    batches = db.prepare("SELECT DISTINCT b.* FROM batches b JOIN orders o ON o.batch_id=b.batch_id WHERE o.order_id=? ORDER BY b.created_at DESC").all(query);
  } else {
    batches = db.prepare("SELECT * FROM batches ORDER BY created_at DESC LIMIT 20").all();
  }
  for (const batch of batches) {
    console.log(`\n=== ${batch.batch_id} | ${batch.mode} | ${batch.status} | ${batch.completed}/${batch.total} ===`);
    const orders = db.prepare("SELECT * FROM orders WHERE batch_id=? ORDER BY queue_index").all(batch.batch_id);
    for (const order of orders) console.log(`#${order.queue_index} ${order.order_id} | ${order.status} | 凭证 ${order.voucher || "-"} | 明细 ${order.detail_count || 0} | ${order.duration_ms ?? "-"}ms`);
    const events = db.prepare("SELECT * FROM events WHERE batch_id=? ORDER BY event_id").all(batch.batch_id);
    for (const event of events) console.log(`${event.event_time} | ${event.order_id || "批次"} | ${event.step} | ${event.phase} | ${event.executor}${event.error_text ? ` | ${event.error_text}` : ""}`);
  }
  db.close();
}
