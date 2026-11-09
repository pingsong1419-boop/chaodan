import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes("erp321.com/epaas"));
  for (const frame of page.frames()) {
    const result = await frame.evaluate(() => [...document.querySelectorAll("textarea, input, [contenteditable=true], [role=dialog], .modal, [class*=dialog], [class*=popup], [class*=layer]")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      })
      .map((element) => ({
        tag: element.tagName,
        id: element.id,
        className: String(element.className || ""),
        name: element.getAttribute("name"),
        placeholder: element.getAttribute("placeholder"),
        value: "value" in element ? String(element.value || "").slice(0, 300) : "",
        text: String(element.innerText || "").replace(/\s+/g, " ").slice(0, 500),
        html: element.outerHTML.slice(0, 1000)
      }))).catch(() => []);
    if (result.length) console.log(JSON.stringify({ url: frame.url(), result }, null, 2));
  }
} finally {
  await browser.close();
}
