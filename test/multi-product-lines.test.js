import test from "node:test";
import assert from "node:assert/strict";
import { parseOrderText } from "../src/parser.js";

test("2653900：换行分隔的两件不同物料必须识别两组尺寸并拦截自动抄单", () => {
  const parsed = parseOrderText("8815 免打孔胀紧帘罩 亚麻肉色 制作宽1.445米 高1.73米 左拉\n8815 免打孔胀紧帘罩 半遮光仿麻白色 制作宽1.25米 高1.73米");
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
