import { chromium } from "playwright-core";
import fs from "node:fs";
import { parseOrderText } from "../src/parser.js";
import { matchSelectionCatalogFromText } from "../src/catalog-match.js";

const catalog = JSON.parse(fs.readFileSync(new URL("../data/selection-catalog.index.json", import.meta.url), "utf8")).records;
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes("erp321.com/epaas"));
  const frame = page?.frames().find((candidate) => candidate.url().includes("/app/order/order/list.aspx"));
  if (!frame) throw new Error("未找到聚水潭订单列表");
  const seen = new Map();
  let stagnant = 0;
  for (let round = 0; round < 10000; round += 1) {
    const rows = await frame.evaluate(() => [...document.querySelectorAll("._jt_row")].map((row) => {
      const textOf = (id) => (row.querySelector(`[data-id="${id}"]`)?.innerText || "").trim();
      const orderId = textOf("o_id").match(/^\s*(\d{7})/)?.[1] || "";
      if (!orderId) return null;
      const items = [...row.querySelectorAll('[data-id="its"] [title]')].map((item) => {
        const title = (item.getAttribute("title") || "").trim();
        const qty = (item.querySelector(".sku_qty")?.textContent || "").trim();
        return [title, qty ? `数量:${qty}` : ""].filter(Boolean).join(" ");
      }).filter(Boolean);
      return {
        orderId,
        items,
        text: [orderId, textOf("labels"), textOf("remark"), textOf("buyer_message"), textOf("shop_buyer_id"), textOf("paid_amount") ? `已付金额: ${textOf("paid_amount")}` : "", textOf("status"), ...items].filter(Boolean).join(" ")
      };
    }).filter(Boolean));
    const before = seen.size;
    for (const row of rows) seen.set(row.orderId, row);
    stagnant = seen.size === before ? stagnant + 1 : 0;
    const moved = await frame.evaluate(() => {
      const grid = document.querySelector("#_jt_body");
      if (!grid) return false;
      const before = grid.scrollTop;
      grid.scrollTop += grid.clientHeight * 0.9;
      return grid.scrollTop !== before;
    });
    if (!moved || stagnant >= 5) break;
    await page.waitForTimeout(350);
  }
  const summary = { total: seen.size, ready: 0, blocked: 0, copied: 0, unique: 0, multiple: 0, none: 0, merged: 0 };
  for (const row of seen.values()) {
    if (/已抄/.test(row.text)) { summary.copied += 1; continue; }
    const parsed = parseOrderText(row.text);
    const match = matchSelectionCatalogFromText({ productCode: parsed.productCode, rawText: row.text, crafts: parsed.crafts }, catalog);
    summary[match.status] += 1;
    const blockers = [...parsed.issues, ...(match.status === "unique" ? [] : ["目录未唯一"]), ...(row.items.length > 1 ? [`多商品(${row.items.length})`] : [])];
    if (row.items.length > 1) summary.merged += 1;
    if (blockers.length) summary.blocked += 1;
    else summary.ready += 1;
    if (row.orderId === "2630640") console.log(JSON.stringify({ orderId: row.orderId, productEvidence: row.items, parsed, catalog: match, blockers }, null, 2));
  }
  console.log(JSON.stringify(summary, null, 2));
  await frame.evaluate(() => { const grid = document.querySelector("#_jt_body"); if (grid) grid.scrollTop = 0; });
} finally {
  await browser.close();
}
