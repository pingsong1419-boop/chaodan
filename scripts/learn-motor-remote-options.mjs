import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
for (const context of browser.contexts()) {
  if (!context.pages().some((page) => page.url().includes("/Edit/"))) {
    const inspectPage = await context.newPage();
    await inspectPage.goto("http://47.121.28.8:200/仓库通用异动单据1_XS/Edit/AAAAA", { waitUntil: "domcontentloaded" });
    await inspectPage.waitForTimeout(1500);
  }
  for (const page of context.pages()) {
    const url = page.url();
    if (!url.includes("47.121.28.8:200")) continue;
    console.log(`PAGE\t${await page.title()}\t${url}`);
    const html = await page.content();
    for (const keyword of ["DM-35", "单频壁挂", "电机型号", "遥控器"]) {
      let at = -1;
      let occurrence = 0;
      while ((at = html.indexOf(keyword, at + 1)) >= 0) {
        occurrence += 1;
        console.log(`HTML_MATCH ${keyword} #${occurrence}: ${html.slice(Math.max(0, at - 500), at + 2000).replace(/\s+/g, " ")}`);
      }
    }
    const scripts = await page.locator("script[src]").evaluateAll((nodes) => nodes.map((node) => node.src));
    console.log(`SCRIPTS\n${scripts.join("\n")}`);
    for (const frame of page.frames()) {
      const selects = await frame.locator("select").evaluateAll((nodes) => nodes.map((node) => {
        const options = [...node.options].map((option) => ({ value: option.value, text: option.textContent?.trim() || "" }));
        const container = node.closest("td, tr, .form-group, div") || node.parentElement;
        return {
          id: node.id,
          name: node.getAttribute("name"),
          className: node.className,
          selected: node.options[node.selectedIndex]?.textContent?.trim() || "",
          nearbyText: (container?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
          options
        };
      })).catch(() => []);
      for (const select of selects) {
        const haystack = `${select.id} ${select.name} ${select.nearbyText} ${select.options.map((x) => x.text).join(" ")}`;
        if (/电机|遥控|单频|多频|DM-35|乐屋|杜亚/i.test(haystack)) {
          console.log(JSON.stringify({ frame: frame.url(), ...select }, null, 2));
        }
      }
    }
  }
}
await browser.close();
