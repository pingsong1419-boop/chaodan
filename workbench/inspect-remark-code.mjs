import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes("erp321.com/epaas"));
  const frame = page?.frames().find((candidate) => candidate.url().includes("/app/order/order/float/remark.aspx"));
  if (!frame) throw new Error("未找到备注弹窗");
  const result = await frame.evaluate(() => ({
    buttons: [...document.querySelectorAll("button,input,a,span,div")].filter((element) => /确定|保存|取消/.test((element.innerText || element.value || "").trim()) && element.children.length < 5).map((element) => ({ tag: element.tagName, id: element.id, className: String(element.className || ""), text: (element.innerText || element.value || "").trim(), onclick: element.getAttribute("onclick"), html: element.outerHTML.slice(0, 1200) })),
    scripts: [...document.scripts].map((script) => script.textContent || "").filter((text) => /remark|Save|保存|SetRemark|CallPage|_ACP/i.test(text)).map((text) => text.slice(0, 12000))
  }));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
