import { chromium } from "playwright-core";
const orderId = process.argv[2];
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes("erp321.com/epaas"));
  const frame = page?.frames().find((candidate) => candidate.url().includes("/app/order/order/list.aspx"));
  const result = await frame.evaluate((target) => {
    const row = [...document.querySelectorAll("._jt_row")].find((element) => (element.querySelector('[data-id="o_id"]')?.innerText || "").includes(target));
    if (!row) return null;
    return {
      checked: Boolean(row.querySelector('input[type="checkbox"]:checked')),
      cells: [...row.querySelectorAll("[data-id]")].map((cell) => ({
      dataId: cell.getAttribute("data-id"),
      text: (cell.innerText || "").trim(),
      title: cell.getAttribute("title"),
      html: cell.outerHTML.slice(0, 2000)
      })).filter((cell) => /o_id|remark|status|备注|改/.test(`${cell.dataId} ${cell.text} ${cell.title}`))
    };
  }, orderId);
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
