import fs from "node:fs";
import path from "node:path";

const target = path.resolve("src/parser.js");
const source = fs.readFileSync(target, "utf8");
const replacement = `export function validateProductionLimits(productCode, width, height, crafts, text, rules = defaultKnowledgeRules) {
  // 2026-11-06 用户确认：尺寸、面积没有权威限制来源，不作为抄单拦截条件。
  // 解析、确认卡片和报价单仍保留原始宽高，只取消上下限与面积判断。
  return [];
}

export function parseOrderText`;
const next = source.replace(
  /export function validateProductionLimits[\s\S]*?\n}\n\nexport function parseOrderText/,
  replacement
);
if (next !== source) fs.writeFileSync(target, next, "utf8");
else if (!source.includes("尺寸、面积没有权威限制来源")) throw new Error("未找到制作限制函数，拒绝写入");

const testTarget = path.resolve("test/production-limits-disabled.test.js");
const testSource = `import test from "node:test";
import assert from "node:assert/strict";
import { parseOrderText } from "../src/parser.js";

test("尺寸和面积不再作为抄单拦截条件", () => {
  const samples = [
    "6010 免打孔 哑光白 制作宽0.32米 高1.2米",
    "6010 打孔 亮光白 制作宽2.15米 高1.5米",
    "8000 手动 防水灰色 制作宽2.0米 高2.8米",
    "5002 日夜帘 白色 制作宽0.52米 高1.2米"
  ];
  for (const text of samples) {
    const parsed = parseOrderText(text);
    assert.ok(!parsed.issues.some((issue) => /制作下限|制作上限|面积|宽度.*过大|低于下限/.test(issue)));
  }
});
`;
fs.writeFileSync(testTarget, testSource, "utf8");
console.log("已取消尺寸与面积拦截");
