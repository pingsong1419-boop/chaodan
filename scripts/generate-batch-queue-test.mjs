import fs from "node:fs";
import path from "node:path";
const target = path.resolve(import.meta.dirname, "../test/batch-queue.test.js");
const source = String.raw`import test from "node:test";
import assert from "node:assert/strict";
import { BatchQueue } from "../src/batch-queue.js";

test("连续队列严格按顺序执行，当前单未完成时禁止进入下一单", () => {
  const queue = new BatchQueue({ batchId: "B1", orders: [{ orderId: "2650002" }, { orderId: "2650001" }] });
  assert.equal(queue.startNext().orderId, "2650002");
  assert.throws(() => queue.startNext(), /尚未结束/);
  queue.completeCurrent({ voucher: "XS1" });
  assert.equal(queue.startNext().orderId, "2650001");
  queue.completeCurrent({ voucher: "XS2" });
  assert.equal(queue.status, "completed");
  assert.equal(queue.completedCount, 2);
});

test("任意订单失败后暂停整批，不自动跳过", () => {
  const queue = new BatchQueue({ batchId: "B2", orders: [{ orderId: "2650001" }, { orderId: "2650002" }] });
  queue.startNext();
  queue.pauseCurrent("目录变化");
  assert.equal(queue.status, "paused");
  assert.equal(queue.startNext(), null);
  assert.equal(queue.items[1].status, "queued");
});
`;
fs.writeFileSync(target, source, "utf8");
console.log(`generated ${target}`);
