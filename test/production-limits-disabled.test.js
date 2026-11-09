import test from "node:test";
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
