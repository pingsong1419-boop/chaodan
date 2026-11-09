import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOrderText } from "../src/parser.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const materials = JSON.parse(fs.readFileSync(path.join(root, "data", "material-map.json"), "utf8")).materials || [];

// 1. 从 512 物料库里收集所有真实出现过的颜色词
const colorWords = new Set();
for (const item of materials) {
  if (item.status !== "confirmed") continue;
  for (const v of item.variants || []) {
    let c = String(v.color || "").trim();
    if (!c) continue;
    c = c.replace(/色$/, "");
    if (c.length >= 2 && c.length <= 6) colorWords.add(c);
  }
  const spec = String(item.searchText || "").trim();
  if (/[\u4e00-\u9fa5]{2,4}$/.test(spec) && spec.length <= 8) {
    const tail = spec.match(/([\u4e00-\u9fa5]{2,4})$/)?.[1];
    if (tail && /白|灰|黑|蓝|绿|黄|粉|红|紫|金|银|橙|棕|褐|咖|米|驼|茶/.test(tail)) colorWords.add(tail);
  }
}

// 2. 拿每个颜色词构造一条订单文本，看现有的规则能不能识别出颜色
const words = [...colorWords].sort();
const missed = [];
const ok = [];
for (const word of words) {
  const text = `6010 免钉 ${word} 制作宽1米 高1米`;
  const parsed = parseOrderText(text);
  const hit = (parsed.colors || []).length > 0;
  if (hit) ok.push({ word, got: parsed.colors.join("/") });
  else missed.push(word);
}

// 3. 检查识别结果是否「看起来不对」：识别出的颜色和原词毫无字面关系
const suspicious = ok.filter(({ word, got }) =>
  !got.split("/").some((g) => g.replace(/色$/, "").includes(word) || word.includes(g.replace(/色$/, "")))
);

const lines = [
  `# 颜色识别覆盖率审计`,
  ``,
  `- 时间：${new Date().toLocaleString()}`,
  `- 物料库：${materials.length} 条，其中提取出颜色词 **${words.length}** 个`,
  `- 规则能识别出颜色的：**${ok.length}** 个`,
  `- 规则完全识别不出颜色的：**${missed.length}** 个`,
  `- 识别结果存疑（和原词对不上）的：**${suspicious.length}** 个`,
  ``,
  `## 完全识别不出的颜色词`,
  ``,
  missed.length ? missed.map((w) => `\`${w}\``).join("、") : "（无）",
  ``,
  `## 识别结果存疑`,
  ``,
  suspicious.length
    ? suspicious.map(({ word, got }) => `- 订单写 \`${word}\` → 识别成 \`${got}\``).join("\n")
    : "（无）",
  ``
].join("\n");

const reportsDir = path.join(here, "reports");
fs.mkdirSync(reportsDir, { recursive: true });
const outPath = path.join(reportsDir, `color-coverage-${new Date().toISOString().slice(0, 10)}.md`);
fs.writeFileSync(outPath, lines, "utf8");

console.log(`物料库 ${materials.length} 条 | 颜色词 ${words.length} 个`);
console.log(`规则识别不出颜色: ${missed.length} 个`);
if (missed.length) console.log(`  ${missed.join("、")}`);
console.log(`识别结果存疑:     ${suspicious.length} 个`);
if (suspicious.length) suspicious.slice(0, 20).forEach((s) => console.log(`  ${s.word} -> ${s.got}`));
console.log(`报告: ${outPath}`);
