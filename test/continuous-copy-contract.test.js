import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

test("连续抄单接入批量预检、单选执行、失败暂停和审计后台", () => {
  assert.match(source, /__codexShowBatchConfirm/);
  assert.match(source, /__codexConfirmBatch/);
  assert.match(source, /document\.querySelectorAll\("input\._jt_cbx:checked"\)/);
  assert.match(source, /activeBatchQueue\.pauseCurrent/);
  assert.match(source, /auditStore\.finishOrder/);
  assert.match(source, /await scheduleNextBatchOrder/);
});

test("原有单笔确认入口仍然保留", () => {
  assert.match(source, /__codexShowCheckedOrderConfirm/);
  assert.match(source, /__codexConfirmCheckedOrder/);
  assert.match(source, /browserConfirmedOrders\.add/);
});
