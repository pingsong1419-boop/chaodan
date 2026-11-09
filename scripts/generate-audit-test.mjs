import fs from "node:fs";
import path from "node:path";
const target = path.resolve(import.meta.dirname, "../test/audit-store.test.js");
const source = String.raw`import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditStore } from "../src/audit-store.js";

test("审计后台记录批次、订单、步骤及最终凭证", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chaodan-audit-"));
  const store = new AuditStore(path.join(dir, "audit.db"), { version: "test-version" });
  store.createBatch({ batchId: "B1", orders: [{ orderId: "2650001" }, { orderId: "2650002" }] });
  store.startOrder("B1", "2650001", { amount: "100.00" });
  store.event({ batchId: "B1", orderId: "2650001", step: "erp-remark", phase: "before", payload: { memoHash: "abc" } });
  store.event({ batchId: "B1", orderId: "2650001", step: "erp-remark", phase: "success", durationMs: 1250 });
  store.finishOrder("B1", "2650001", { voucher: "XS001", detailCount: 2, durationMs: 8000 });
  const result = store.getBatch("B1");
  assert.equal(result.batch.completed, 1);
  assert.equal(result.orders[0].voucher, "XS001");
  assert.equal(result.orders[0].detail_count, 2);
  assert.ok(result.events.some((event) => event.step === "erp-remark" && event.phase === "success"));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
`;
fs.writeFileSync(target, source, "utf8");
console.log(`generated ${target}`);
