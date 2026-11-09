import fs from "node:fs";
import path from "node:path";

const target = path.resolve(import.meta.dirname, "../src/audit-store.js");
const source = String.raw`import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function json(value) {
  try { return JSON.stringify(value ?? null); } catch { return JSON.stringify({ serializationError: true }); }
}

export class AuditStore {
  constructor(filename, { version = "unknown" } = {}) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.version = version;
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS batches (batch_id TEXT PRIMARY KEY, mode TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, total INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, program_version TEXT, summary_json TEXT);" +
      "CREATE TABLE IF NOT EXISTS orders (batch_id TEXT NOT NULL, order_id TEXT NOT NULL, queue_index INTEGER NOT NULL, status TEXT NOT NULL, started_at TEXT, finished_at TEXT, voucher TEXT, detail_count INTEGER DEFAULT 0, duration_ms INTEGER, input_json TEXT, result_json TEXT, error_text TEXT, PRIMARY KEY(batch_id, order_id), FOREIGN KEY(batch_id) REFERENCES batches(batch_id));" +
      "CREATE TABLE IF NOT EXISTS events (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_time TEXT NOT NULL, batch_id TEXT, order_id TEXT, step TEXT NOT NULL, phase TEXT NOT NULL, executor TEXT NOT NULL, duration_ms INTEGER, payload_json TEXT, error_text TEXT, program_version TEXT);" +
      "CREATE INDEX IF NOT EXISTS idx_events_order ON events(order_id, event_time);" +
      "CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, started_at);"
    );
    this.db.prepare("UPDATE batches SET status='interrupted', finished_at=? WHERE status IN ('running','paused')").run(new Date().toISOString());
    this.db.prepare("UPDATE orders SET status='interrupted', finished_at=? WHERE status='running'").run(new Date().toISOString());
  }

  createBatch({ batchId, mode = "batch", orders = [], summary = {} }) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO batches(batch_id,mode,status,created_at,started_at,total,program_version,summary_json) VALUES(?,?,?,?,?,?,?,?)")
        .run(batchId, mode, "running", now, now, orders.length, this.version, json(summary));
      const insert = this.db.prepare("INSERT INTO orders(batch_id,order_id,queue_index,status,input_json) VALUES(?,?,?,?,?)");
      orders.forEach((order, index) => insert.run(batchId, String(order.orderId), index + 1, "queued", json(order)));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  startOrder(batchId, orderId, input = {}) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE orders SET status='running', started_at=?, input_json=? WHERE batch_id=? AND order_id=?")
      .run(now, json(input), batchId, String(orderId));
    this.event({ batchId, orderId, step: "order", phase: "start", payload: input });
  }

  event({ batchId = null, orderId = null, step, phase, executor = "automation", durationMs = null, payload = null, error = null }) {
    this.db.prepare("INSERT INTO events(event_time,batch_id,order_id,step,phase,executor,duration_ms,payload_json,error_text,program_version) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(new Date().toISOString(), batchId, orderId ? String(orderId) : null, step, phase, executor, durationMs, json(payload), error ? String(error) : null, this.version);
  }

  finishOrder(batchId, orderId, { status = "completed", voucher = "", detailCount = 0, durationMs = null, result = null, error = null } = {}) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE orders SET status=?,finished_at=?,voucher=?,detail_count=?,duration_ms=?,result_json=?,error_text=? WHERE batch_id=? AND order_id=?")
      .run(status, now, voucher, detailCount, durationMs, json(result), error ? String(error) : null, batchId, String(orderId));
    this.event({ batchId, orderId, step: "order", phase: status, durationMs, payload: result, error });
    this.refreshBatch(batchId);
  }

  refreshBatch(batchId) {
    const counts = this.db.prepare("SELECT COUNT(*) total, SUM(status='completed') completed, SUM(status IN ('failed','paused','interrupted')) failed FROM orders WHERE batch_id=?").get(batchId);
    this.db.prepare("UPDATE batches SET total=?,completed=?,failed=? WHERE batch_id=?")
      .run(Number(counts.total || 0), Number(counts.completed || 0), Number(counts.failed || 0), batchId);
  }

  finishBatch(batchId, { status = "completed", summary = {} } = {}) {
    this.refreshBatch(batchId);
    this.db.prepare("UPDATE batches SET status=?,finished_at=?,summary_json=? WHERE batch_id=?")
      .run(status, new Date().toISOString(), json(summary), batchId);
    this.event({ batchId, step: "batch", phase: status, payload: summary });
  }

  getBatch(batchId) {
    return {
      batch: this.db.prepare("SELECT * FROM batches WHERE batch_id=?").get(batchId),
      orders: this.db.prepare("SELECT * FROM orders WHERE batch_id=? ORDER BY queue_index").all(batchId),
      events: this.db.prepare("SELECT * FROM events WHERE batch_id=? ORDER BY event_id").all(batchId)
    };
  }

  close() { this.db.close(); }
}
`;
fs.writeFileSync(target, source, "utf8");
console.log(`generated ${target}`);
