import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes("erp321.com/epaas"));
  if (!page) throw new Error("未找到聚水潭页面");
  const orderFrame = page.frames().find((frame) => frame.url().includes("/app/order/order/list.aspx"));
  if (!orderFrame) {
    const homeFrame = page.frames().find((frame) => frame.url().includes("/erp-web-group/home/"));
    if (!homeFrame) throw new Error("未找到聚水潭首页");
    await homeFrame.getByText("订单", { exact: true }).first().click();
    await page.waitForTimeout(2500);
  }
  const targetFrame = page.frames().find((frame) => frame.url().includes("/app/order/order/list.aspx"));
  if (!targetFrame) throw new Error("点击订单后仍未进入订单列表");
  const filterFrame = page.frames().find((frame) => frame.url().includes("/app/order/filter/filter.aspx"));
  if (!filterFrame) throw new Error("未找到订单查询池面板");
  const pool = filterFrame.locator("#search_list_p");
  if (!(await pool.isVisible().catch(() => false))) {
    await filterFrame.getByText("查询池", { exact: true }).click({ noWaitAfter: true });
    await page.waitForTimeout(500);
  }
  const tmall = filterFrame.locator("#u_search_list .search_item_text", { hasText: /^天猫$/ }).first();
  if (!(await tmall.count())) throw new Error("查询池中未找到天猫");
  await tmall.click({ noWaitAfter: true });
  await page.waitForTimeout(3500);
  console.log(`已进入天猫查询池：${targetFrame.url()}`);
} finally {
  await browser.close();
}
