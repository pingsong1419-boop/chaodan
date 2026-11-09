import { chromium } from "playwright-core";
import fs from "node:fs";
import { parseOrderText } from "../src/parser.js";
import { matchSelectionCatalogFromText } from "../src/catalog-match.js";

const orderId = process.argv[2];
if (!/^\d{7}$/.test(orderId || "")) throw new Error("请提供7位内部订单号");
const catalog = JSON.parse(fs.readFileSync(new URL("../data/selection-catalog.index.json", import.meta.url), "utf8")).records;
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes("erp321.com/epaas"));
  const frame = page?.frames().find((candidate) => candidate.url().includes("/app/order/order/list.aspx"));
  if (!frame) throw new Error("未找到聚水潭订单列表");
  const row = await frame.evaluate((targetId) => {
    for (const element of document.querySelectorAll("._jt_row")) {
      const textOf = (id) => (element.querySelector(`[data-id="${id}"]`)?.innerText || "").trim();
      if (!textOf("o_id").includes(targetId)) continue;
      const items = [...element.querySelectorAll('[data-id="its"] [title]')].map((item) => (item.getAttribute("title") || "").trim()).filter(Boolean);
      return {
        items,
        text: [targetId, textOf("labels"), textOf("remark"), textOf("buyer_message"), textOf("paid_amount") ? `已付金额: ${textOf("paid_amount")}` : "", textOf("status"), ...items].filter(Boolean).join(" ")
      };
    }
    return null;
  }, orderId);
  if (!row) throw new Error(`当前可见列表未找到订单 ${orderId}`);
  const parsed = parseOrderText(row.text);
  const result = matchSelectionCatalogFromText({ productCode: parsed.productCode, rawText: row.text, crafts: parsed.crafts }, catalog);
  console.log(JSON.stringify({ orderId, items: row.items, parsed, status: result.status, extracted: result.extracted, candidates: result.candidates?.map(({ id, projectName, specification, specification2, color, searchText, score, reasons }) => ({ id, projectName, specification, specification2, color, score, reasons, searchText })) }, null, 2));
} finally {
  await browser.close();
}
