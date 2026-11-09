import fs from "node:fs";
import path from "node:path";
const file = path.resolve(import.meta.dirname, "../test/multi-material-order.test.js");
const source = `import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildOrderLinePlans, linePlanBlockers, splitProductSpecSegments } from "../src/order-line-plans.js";

const catalog = JSON.parse(fs.readFileSync(new URL("../data/selection-catalog.index.json", import.meta.url), "utf8")).records;
const mappings = JSON.parse(fs.readFileSync(new URL("../data/material-map.json", import.meta.url), "utf8"));
const orderText = "8815 免打孔胀紧帘罩 亚麻肉色 制作宽1.445米 高1.73米 左拉 8815 免打孔胀紧帘罩 半遮光仿麻白色 制作宽1.25米 高1.73米";

test("2653900：两个不同规格分别唯一命中两个权威目录并允许抄单", () => {
  assert.equal(splitProductSpecSegments(orderText).length, 2);
  const plans = buildOrderLinePlans(orderText, catalog, mappings.materials);
  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map((plan) => plan.catalogMatch.match.id), ["NE0002172", "NE0002228"]);
  assert.deepEqual(plans.map((plan) => plan.resolvedMaterial.outputText), ["8815 8255", "8815 6695"]);
  assert.deepEqual(plans.map((plan) => [plan.rows[0].width, plan.rows[0].height, plan.rows[0].remark]), [
    [1.445, 1.73, "左拉"],
    [1.25, 1.73, ""]
  ]);
  assert.deepEqual(linePlanBlockers(plans), []);
});

test("2653536：同一款号的A/B两组尺寸共用一个权威目录", () => {
  const text = "6010 免钉【亮光】薄荷色 A:制作宽0.5米 高1.26米 B:制作宽0.59米 高1.28米";
  assert.equal(splitProductSpecSegments(text).length, 1);
  const plans = buildOrderLinePlans(text, catalog, mappings.materials);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].catalogMatch.status, "unique");
  assert.equal(plans[0].rows.length, 2);
  assert.deepEqual(plans[0].rows.map((row) => [row.width, row.height]), [[0.5, 1.26], [0.59, 1.28]]);
  assert.deepEqual(linePlanBlockers(plans), []);
});
`;
fs.writeFileSync(file, source, "utf8");
console.log("created multi-material test");
