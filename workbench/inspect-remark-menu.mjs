import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes("erp321.com/epaas"));
  const orderFrame = page?.frames().find((frame) => frame.url().includes("/app/order/order/list.aspx"));
  if (!orderFrame) throw new Error("未找到订单列表");
  const button = orderFrame.locator("button, a, span, div").filter({ hasText: /^修改&标记$/ }).first();
  if (!(await button.isVisible())) throw new Error("未找到修改&标记按钮");
  await button.click({ force: true, noWaitAfter: true });
  await page.waitForTimeout(500);
  for (const frame of page.frames()) {
    const entries = await frame.evaluate(() => [...document.querySelectorAll("li,a,span,div")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && /备注|标记/.test((element.innerText || "").trim()) && element.children.length < 8;
      })
      .map((element) => ({ tag: element.tagName, id: element.id, className: String(element.className || ""), text: (element.innerText || "").trim(), title: element.getAttribute("title"), html: element.outerHTML.slice(0, 1200) }))
      .slice(0, 80)).catch(() => []);
    if (entries.length) console.log(JSON.stringify({ url: frame.url(), entries }, null, 2));
  }
} finally {
  await browser.close();
}
