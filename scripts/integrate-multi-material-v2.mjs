import fs from "node:fs";
import path from "node:path";
const file = path.resolve(import.meta.dirname, "../src/index.js");
let lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
const find = (needle, start = 0) => {
  const i = lines.findIndex((line, index) => index >= start && line.includes(needle));
  if (i < 0) throw new Error("missing: " + needle);
  return i;
};
const replaceLine = (needle, replacement, start = 0) => {
  const i = find(needle, start);
  lines.splice(i, 1, ...replacement);
  return i;
};

let i = find('import { matchSelectionCatalogFromText }');
lines.splice(i + 1, 0, 'import { buildOrderLinePlans, linePlanBlockers } from "./order-line-plans.js";');

i = find("const catalogMatch = matchSelectionCatalogFromText", 300);
lines.splice(i, 3,
  "    const linePlans = buildOrderLinePlans(text, selectionCatalog, mappings.materials);",
  "    const catalogMatch = linePlans[0]?.catalogMatch || { status: \"none\" };",
  "    const detailRows = linePlans.flatMap((plan) => plan.rows);"
);
replaceLine("const blockers = [...new Set([...processedBlockers", [
  "    const blockers = [...new Set([...processedBlockers, ...linePlanBlockers(linePlans), ...(!amount ? [\"未识别成交金额\"] : [])])];"
], 300);
replaceLine("product: `${parsed.productCode", [
  "      product: linePlans.map((plan, index) => `${index + 1}. ${plan.parsed.productCode || \"未识别\"} | ${plan.parsed.crafts.join(\"+\") || \"无工艺\"} | ${plan.catalogMatch.extracted?.color || \"未识别颜色\"}`).join(\"；\"),"
], 300);
replaceLine("catalog: catalogMatch.status", [
  "      catalog: linePlans.map((plan, index) => plan.catalogMatch.status === \"unique\" ? `${index + 1}. ${plan.catalogMatch.match.id} | ${plan.catalogMatch.match.specification} | ${plan.catalogMatch.match.color}` : `${index + 1}. 未唯一命中`).join(\"；\"),"
], 300);
replaceLine("selection: catalogCode", [
  "      selection: linePlans.map((plan, index) => `${index + 1}. ${plan.resolvedMaterial?.outputText || \"未确认\"}`).join(\"；\"),"
], 300);

const mainAnchor = find("const browserPreconfirmed", 1900);
const mainStart = find("const ruleResolved =", mainAnchor);
const mainEnd = find("let rows = buildDetailRows", mainStart);
lines.splice(mainStart, mainEnd - mainStart + 1,
  "      const linePlans = buildOrderLinePlans(text, selectionCatalog, mappings.materials);",
  "      const allCatalogUnique = linePlans.length > 0 && linePlans.every((plan) => plan.catalogMatch.status === \"unique\" && plan.resolvedMaterial);",
  "      // 单值仅兼容既有日志；每条报价明细实际使用所属规格段的权威目录。",
  "      const catalogMatch = linePlans[0]?.catalogMatch || { status: \"none\", candidates: [] };",
  "      const resolvedMaterial = linePlans[0]?.resolvedMaterial || null;",
  "      const ruleResolved = resolveMaterialText(parsed, mappings.materials);",
  "      let rows = linePlans.flatMap((plan) => plan.rows);"
);

replaceLine("if (!resolvedMaterial || catalogMatch.status", ["        if (!allCatalogUnique) {"], mainAnchor);
replaceLine("console.log(`已暂停：${catalogMatch.status", [
  "          console.log(`已暂停：${linePlanBlockers(linePlans).join(\"；\") || \"订单规格段未全部唯一命中权威目录\"}。未执行任何录入。`);"
], mainAnchor);
replaceLine("const previewBlockers =", [
  "        const previewBlockers = [...processedOrderBlockers(text), ...linePlanBlockers(linePlans), ...(!orderId ? [\"未识别订单号\"] : []), ...(!amount ? [\"未识别成交金额\"] : [])];"
], mainAnchor);
replaceLine("const blockers = [...new Set([...processedBlockers", [
  "      const blockers = [...new Set([...processedBlockers, ...linePlanBlockers(linePlans), ...(!orderId ? [\"未识别订单号\"] : []), ...(!amount ? [\"未识别成交金额\"] : [])])];"
], mainAnchor);

i = find("const currentRow = rows[rowIndex]", mainAnchor);
lines.splice(i + 1, 0, "              const currentPlan = linePlans[currentRow.linePlanIndex ?? 0];");
replaceLine("chooseMaterial(quote, resolvedMaterial.outputText", [
  "              const materialResult = await withHumanTakeover(quote, `${rowPrefix}物料选择`, () => chooseMaterial(quote, currentPlan.resolvedMaterial.outputText, currentPlan.parsed, currentPlan.catalogMatch.match, (step, name, details) => quoteGate(step, name, `${rowPrefix}${details}`), rowIndex + 1, rows.length));"
], i);
replaceLine("fillAndSaveDetail(quote, parsed, resolvedMaterial", [
  "              await withHumanTakeover(quote, `${rowPrefix}明细填写与保存`, () => fillAndSaveDetail(quote, currentPlan.parsed, currentPlan.resolvedMaterial, quoteGate, currentRow, rowIndex + 1, rows.length, materialResult?.detailRow));"
], i);

fs.writeFileSync(file, lines.join("\n"), "utf8");
console.log("integrated multi-material plans v2");
