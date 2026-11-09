import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
for (const page of browser.contexts()[0].pages()) {
  console.log(`PAGE ${page.url()}`);
  for (const frame of page.frames()) {
    const result = await frame.evaluate(() => {
      const rows = [...document.querySelectorAll("._jt_row")];
      if (!rows.length) return null;
      const values = rows.map((row) => ({
        id: (row.querySelector('[data-id="o_id"]')?.innerText || "").trim(),
        item: [...row.querySelectorAll('[data-id="its"] [title]')]
          .map((element) => element.getAttribute("title"))
          .filter(Boolean)
          .join(" | ")
      }));
      return {
        url: location.href,
        rows: rows.length,
        valid: values.filter((value) => /^\d{7}$/.test(value.id)).length,
        invalid: values.filter((value) => !/^\d{7}$/.test(value.id)),
        duplicates: values.filter((value, index, all) => value.id && all.findIndex((other) => other.id === value.id) !== index)
      };
    }).catch(() => null);
    if (result) console.log(JSON.stringify(result, null, 2));
    if (!result) {
      const summary = await frame.evaluate(() => ({
        url: location.href,
        text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 800),
        targets: [...document.querySelectorAll("*")]
          .filter((element) => ["查询池", "天猫"].includes((element.textContent || "").trim()))
          .slice(0, 20)
          .map((element) => ({ tag: element.tagName, id: element.id, className: element.className, html: element.outerHTML.slice(0, 500) })),
        links: [...document.querySelectorAll("a")].slice(0, 30).map((a) => ({ text: (a.innerText || "").trim(), href: a.href }))
      })).catch(() => null);
      if (summary?.text) console.log(JSON.stringify(summary, null, 2));
    }
  }
}
await browser.close();
