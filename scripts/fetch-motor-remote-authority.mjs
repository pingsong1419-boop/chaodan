import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes("47.121.28.8:200"));
if (!page) throw new Error("未找到报价系统页面");
const authority = { fetchedAt: new Date().toISOString(), source: "报价系统常用资料只读接口", motor: [], remote: [] };
for (const [type, id] of [["motor", "dianjixingaho"], ["remote", "yaokongqi"]]) {
  const html = await page.evaluate(async (selectId) => {
    const response = await fetch(`/常用资料/GetSelectHtml?id=${selectId}`, { credentials: "include" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.text();
  }, id);
  const options = await page.evaluate((markup) => {
    const select = document.createElement("select");
    select.innerHTML = markup;
    return [...select.options].map((option) => ({ value: option.value, text: option.textContent.trim() }));
  }, html);
  console.log(JSON.stringify({ type, id, count: options.length, options }, null, 2));
  authority[type] = options.filter((option) => option.value && option.text);
}
fs.writeFileSync(path.resolve(import.meta.dirname, "../data/motor-remote-authority.json"), JSON.stringify(authority, null, 2), "utf8");
await browser.close();
