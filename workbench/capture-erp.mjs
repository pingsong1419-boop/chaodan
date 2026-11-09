import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes("erp321.com/epaas"));
await page.screenshot({ path: "workbench/erp-current.png" });
await browser.close();
