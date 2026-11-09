import { chromium } from "playwright-core";
import fs from "node:fs";
import { parseOrderText } from "../src/parser.js";
import { matchSelectionCatalogFromText } from "../src/catalog-match.js";

const catalog = JSON.parse(fs.readFileSync(new URL("../data/selection-catalog.index.json", import.meta.url), "utf8")).records;
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  const page = browser.contexts()[0].pages().find((item) => item.url().includes("/epaas"));
  const frame = page.frames().find((item) => item.url().includes("/app/order/order/list.aspx"));
  const rawRows = await frame.evaluate(() => [...document.querySelectorAll("._jt_row")].slice(0, 20).map((row, index) => {
    const textOf = (id) => (row.querySelector(`[data-id="${id}"]`)?.innerText || "").trim();
    const itemCell = row.querySelector('[data-id="its"]');
    const items = itemCell ? [...itemCell.querySelectorAll("[title]")].map((item) => {
      const title = (item.getAttribute("title") || "").trim();
      const qty = (item.querySelector(".sku_qty")?.textContent || "").trim();
      return [title, qty ? `数量:${qty}` : ""].filter(Boolean).join(" ");
    }).filter(Boolean) : [];
    return {
      sequence: index + 1,
      orderId: textOf("o_id"),
      combinedText: [textOf("o_id"), textOf("labels"), textOf("remark"), textOf("buyer_message"), textOf("shop_buyer_id"), textOf("paid_amount") ? `已付金额: ${textOf("paid_amount")}` : "", textOf("status"), ...items].filter(Boolean).join(" ")
    };
  }));
  const results = rawRows.map((row) => {
    const parsed = parseOrderText(row.combinedText);
    const match = matchSelectionCatalogFromText({ productCode: parsed.productCode, rawText: row.combinedText, crafts: parsed.crafts }, catalog);
    const blockers = [...parsed.issues, ...(match.status !== "unique" ? [match.status === "multiple" ? "目录多候选" : "目录无候选"] : [])];
    return { sequence: row.sequence, orderId: row.orderId, productCode: parsed.productCode, color: match.extracted?.color || "", crafts: parsed.crafts, size: parsed.width && parsed.height ? `${parsed.width}×${parsed.height}` : "未识别", catalogId: match.match?.id || "", material: match.match?.color || "", status: blockers.length ? "blocked" : "ready", reason: blockers.join("；"), source: row.combinedText };
  });
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
