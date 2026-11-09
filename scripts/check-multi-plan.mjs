import fs from "node:fs";
import { buildOrderLinePlans } from "../src/order-line-plans.js";
const catalog = JSON.parse(fs.readFileSync(new URL("../data/selection-catalog.index.json", import.meta.url), "utf8")).records;
const mappings = JSON.parse(fs.readFileSync(new URL("../data/material-map.json", import.meta.url), "utf8"));
const text = "8815 免打孔胀紧帘罩 亚麻肉色 制作宽1.445米 高1.73米 左拉 8815 免打孔胀紧帘罩 半遮光仿麻白色 制作宽1.25米 高1.73米";
console.log(JSON.stringify(buildOrderLinePlans(text, catalog, mappings.materials).map((plan) => ({
  segment: plan.segment,
  code: plan.parsed.productCode,
  catalog: plan.catalogMatch.status + ":" + (plan.catalogMatch.match?.id || ""),
  search: plan.resolvedMaterial?.outputText,
  row: plan.rows[0]
})), null, 2));
