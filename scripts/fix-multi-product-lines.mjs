import fs from "node:fs";
import path from "node:path";

const parserPath = path.resolve("src/parser.js");
let source = fs.readFileSync(parserPath, "utf8");
const oldProductLine = `  const productLine = String(rawText ?? "").split(/\\r?\\n/).find((line) =>
    (!productCode || line.includes(productCode)) && /(?:制作)?宽/.test(line) && /(?:制作)?高/.test(line)
  ) || text;`;
const newProductLine = `  const productLines = String(rawText ?? "").split(/\\r?\\n/).filter((line) =>
    (!productCode || line.includes(productCode)) && /(?:制作)?宽/.test(line) && /(?:制作)?高/.test(line)
  );
  const productLine = productLines.length ? productLines.join(" ") : text;`;
if (source.includes(oldProductLine)) source = source.replace(oldProductLine, newProductLine);
else if (!source.includes("const productLines =")) throw new Error("未找到商品行提取逻辑");

const dimensionAnchor = `  const dimensionMatches = [...productLine.matchAll(/(?:制作)?宽(?:度)?\\s*:?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:米|m)?\\s*高(?:度)?\\s*:?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:米|m)?/gi)];`;
const segmentDetection = `  const productCodeOccurrences = productCode ? text.toUpperCase().split(productCode).length - 1 : 0;
  const hasMultipleProductSegments = productLines.length > 1 || (dimensionMatches.length > 1 && productCodeOccurrences > 1);`;
if (!source.includes("const hasMultipleProductSegments =")) {
  if (!source.includes(dimensionAnchor)) throw new Error("未找到尺寸匹配锚点");
  source = source.replace(dimensionAnchor, `${dimensionAnchor}\n${segmentDetection}`);
}

const issueAnchor = `  if (!productCode) issues.push("未识别产品代号");`;
const oldMultiLineIssue = /  if \(productLines\.length > 1\) issues\.push\(`一单包含\$\{productLines\.length\}行独立商品规格，且可能使用不同物料，暂不自动抄单`\);/;
const multiLineIssue = `  if (hasMultipleProductSegments) issues.push(\`一单包含\${dimensionMatches.length}个独立商品规格段，且可能使用不同物料，暂不自动抄单\`);`;
if (oldMultiLineIssue.test(source)) source = source.replace(oldMultiLineIssue, multiLineIssue);
else if (!source.includes(multiLineIssue)) {
  if (!source.includes(issueAnchor)) throw new Error("未找到问题列表锚点");
  source = source.replace(issueAnchor, `${issueAnchor}\n${multiLineIssue}`);
}
fs.writeFileSync(parserPath, source, "utf8");

const testPath = path.resolve("test/multi-product-lines.test.js");
fs.writeFileSync(testPath, `import test from "node:test";
import assert from "node:assert/strict";
import { parseOrderText } from "../src/parser.js";

test("2653900：换行分隔的两件不同物料必须识别两组尺寸并拦截自动抄单", () => {
  const parsed = parseOrderText("8815 免打孔胀紧帘罩 亚麻肉色 制作宽1.445米 高1.73米 左拉\\n8815 免打孔胀紧帘罩 半遮光仿麻白色 制作宽1.25米 高1.73米");
  assert.deepEqual(parsed.dimensionPairs, [
    { width: 1.445, height: 1.73 },
    { width: 1.25, height: 1.73 }
  ]);
  assert.equal(parsed.quantity, 2);
  assert.ok(parsed.issues.some((issue) => issue.includes("2个独立商品规格段")));
});

test("2653900：网络缓存压平换行后仍按重复款号和两组尺寸拦截", () => {
  const parsed = parseOrderText("8815 免打孔胀紧帘罩 亚麻肉色 制作宽1.445米 高1.73米 左拉 8815 免打孔胀紧帘罩 半遮光仿麻白色 制作宽1.25米 高1.73米");
  assert.equal(parsed.dimensionPairs.length, 2);
  assert.ok(parsed.issues.some((issue) => issue.includes("2个独立商品规格段")));
});
`, "utf8");
console.log("已识别多行商品并增加安全拦截");
