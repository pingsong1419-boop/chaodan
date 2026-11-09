import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes("erp321.com/epaas"));
  const filterFrame = page?.frames().find((frame) => frame.url().includes("/app/order/filter/filter.aspx"));
  if (!filterFrame) throw new Error("未找到查询面板");
  await filterFrame.getByText("查询池", { exact: true }).click({ noWaitAfter: true });
  await page.waitForTimeout(1200);
  const filterState = await filterFrame.evaluate(() => ({
    tail: (document.body?.innerText || "").slice(-2500),
    dialogs: [...document.querySelectorAll('*')]
      .filter((element) => (element.innerText || "").includes("自定义查询池") && element.children.length < 20)
      .filter((element) => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0)
      .slice(0, 30)
      .map((element) => ({ tag: element.tagName, id: element.id, className: element.className, text: (element.innerText || "").slice(0, 800), html: element.outerHTML.slice(0, 2000) }))
  }));
  console.log(JSON.stringify(filterState, null, 2));
  for (const frame of page.frames()) {
    const found = await frame.evaluate(() => [...document.querySelectorAll("*")]
      .filter((element) => (element.textContent || "").trim() === "天猫")
      .slice(0, 20)
      .map((element) => ({ tag: element.tagName, className: element.className, title: element.getAttribute("title"), html: element.outerHTML.slice(0, 600) }))).catch(() => []);
    if (found.length) console.log(JSON.stringify({ url: frame.url(), found }, null, 2));
  }
} finally {
  await browser.close();
}
