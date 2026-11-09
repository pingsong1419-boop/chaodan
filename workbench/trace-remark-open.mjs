import { chromium } from "playwright-core";
const orderId = process.argv[2];
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes("erp321.com/epaas"));
  const frame = page?.frames().find((candidate) => candidate.url().includes("/app/order/order/list.aspx"));
  if (!frame) throw new Error("未找到订单列表");
  const requests = [];
  const handler = (request) => requests.push({ method: request.method(), url: request.url(), postData: request.postData() });
  page.on("request", handler);
  const cell = frame.locator("._jt_row").filter({ has: frame.locator('[data-id="o_id"]', { hasText: orderId }) }).locator('[data-id="remark"]').first();
  if (!(await cell.count())) throw new Error("未找到目标订单备注单元格");
  await cell.hover();
  await cell.locator(".h_btn_show_remark").click({ force: true, noWaitAfter: true });
  await page.waitForTimeout(2500);
  page.off("request", handler);
  console.log(JSON.stringify({
    requests,
    frames: page.frames().map((item) => item.url()),
    visibleEditors: await Promise.all(page.frames().map(async (item) => ({
      url: item.url(),
      editors: await item.locator("textarea:visible, input:visible, [contenteditable=true]:visible").evaluateAll((elements) => elements.map((element) => ({ tag: element.tagName, id: element.id, name: element.getAttribute("name"), value: element.value || element.innerText || "", placeholder: element.getAttribute("placeholder") }))).catch(() => [])
    })))
  }, null, 2));
} finally { await browser.close(); }
