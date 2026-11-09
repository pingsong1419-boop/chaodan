import fs from "node:fs";
import path from "node:path";
const target = path.resolve(import.meta.dirname, "../src/batch-queue.js");
const source = String.raw`export function createBatchId(now = new Date()) {
  const p = (n, width = 2) => String(n).padStart(width, "0");
  return "B" + now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) + "-" + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds()) + "-" + p(now.getMilliseconds(), 3);
}

export class BatchQueue {
  constructor({ batchId, orders }) {
    if (!batchId || !Array.isArray(orders) || orders.length < 2) throw new Error("连续抄单至少需要2笔订单");
    const unique = new Set();
    this.batchId = batchId;
    this.items = orders.map((order, index) => {
      const orderId = String(order.orderId || "");
      if (!/^\d{7}$/.test(orderId)) throw new Error("队列包含无效订单号");
      if (unique.has(orderId)) throw new Error("队列包含重复订单号：" + orderId);
      unique.add(orderId);
      return { ...order, orderId, queueIndex: index + 1, status: "queued", result: null };
    });
    this.currentIndex = -1;
    this.status = "ready";
  }

  startNext() {
    if (!['ready', 'running'].includes(this.status)) return null;
    if (this.currentIndex >= 0 && this.items[this.currentIndex].status === "running") throw new Error("当前订单尚未结束，禁止进入下一单");
    const nextIndex = this.items.findIndex((item, index) => index > this.currentIndex && item.status === "queued");
    if (nextIndex < 0) { this.status = "completed"; return null; }
    this.currentIndex = nextIndex;
    this.status = "running";
    this.items[nextIndex].status = "running";
    return this.items[nextIndex];
  }

  completeCurrent(result = {}) {
    const item = this.current();
    if (!item || item.status !== "running") throw new Error("没有正在执行的订单");
    item.status = "completed";
    item.result = result;
    if (this.items.every((entry) => entry.status === "completed")) this.status = "completed";
    return item;
  }

  pauseCurrent(error) {
    const item = this.current();
    if (item?.status === "running") {
      item.status = "paused";
      item.result = { error: String(error || "未知错误") };
    }
    this.status = "paused";
    return item;
  }

  current() { return this.currentIndex >= 0 ? this.items[this.currentIndex] : null; }
  get completedCount() { return this.items.filter((item) => item.status === "completed").length; }
  get total() { return this.items.length; }
  snapshot() { return { batchId: this.batchId, status: this.status, currentIndex: this.currentIndex, items: this.items }; }
}
`;
fs.writeFileSync(target, source, "utf8");
console.log(`generated ${target}`);
