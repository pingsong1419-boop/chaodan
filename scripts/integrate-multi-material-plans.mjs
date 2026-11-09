import fs from "node:fs";
import path from "node:path";
const file = path.resolve(import.meta.dirname, "../src/index.js");
let s = fs.readFileSync(file, "utf8");
function replaceOnce(from, to, label) {
  if (!s.includes(from)) throw new Error(`missing ${label}`);
  s = s.replace(from, to);
}

replaceOnce(
  'import { matchSelectionCatalogFromText } from "./catalog-match.js";',
  'import { matchSelectionCatalogFromText } from "./catalog-match.js";\nimport { buildOrderLinePlans, linePlanBlockers } from "./order-line-plans.js";',
  "import"
);

replaceOnce(
`    const catalogMatch = matchSelectionCatalogFromText({ productCode: parsed.productCode, rawText: text, crafts: parsed.crafts }, selectionCatalog);
    const catalogCode = catalogMatch.status === "unique" ? (catalogMatch.match.color.match(/M-(\\d+)/i)?.[1] || catalogMatch.match.id) : "";
    const detailRows = buildDetailRows(parsed);`,
`    const linePlans = buildOrderLinePlans(text, selectionCatalog, mappings.materials);
    const catalogMatch = linePlans[0]?.catalogMatch || { status: "none" };
    const detailRows = linePlans.flatMap((plan) => plan.rows);`,
  "browser plans"
);
replaceOnce(
`    const blockers = [...new Set([...processedBlockers, ...parsed.issues, ...(!amount ? ["未识别成交金额"] : []), ...(catalogMatch.status !== "unique" ? [catalogMatch.status === "multiple" ? "权威目录存在多个候选" : "权威目录无可靠候选"] : []), ...(isMultiPieceOrder(parsed) ? ["一单多件或多组尺寸，暂不处理"] : [])])];`,
`    const blockers = [...new Set([...processedBlockers, ...linePlanBlockers(linePlans), ...(!amount ? ["未识别成交金额"] : [])])];`,
  "browser blockers"
);
replaceOnce(
`      product: \\`${parsed.productCode || "未识别"} | \\${parsed.crafts.join("+") || "无工艺"} | \\${catalogMatch.extracted?.color || "未识别颜色"}\\`,`,
`      product: linePlans.map((plan, index) => \\`${index + 1}. \\${plan.parsed.productCode || "未识别"} | \\${plan.parsed.crafts.join("+") || "无工艺"} | \\${plan.catalogMatch.extracted?.color || "未识别颜色"}\\`).join("；"),`,
  "browser product"
);
replaceOnce(
`      catalog: catalogMatch.status === "unique" ? \\`${catalogMatch.match.id} | \\${catalogMatch.match.specification} | \\${catalogMatch.match.color}\\` : "未唯一命中",
      selection: catalogCode ? \\`${parsed.productCode} \\${catalogCode}\\` : "未确认",`,
`      catalog: linePlans.map((plan, index) => plan.catalogMatch.status === "unique" ? \\`${index + 1}. \\${plan.catalogMatch.match.id} | \\${plan.catalogMatch.match.specification} | \\${plan.catalogMatch.match.color}\\` : \\`${index + 1}. 未唯一命中\\`).join("；"),
      selection: linePlans.map((plan, index) => \\`${index + 1}. \\${plan.resolvedMaterial?.outputText || "未确认"}\\`).join("；"),`,
  "browser catalog"
);

const mainStart = `      const ruleResolved = resolveMaterialText(parsed, mappings.materials);

      // 规则映射只保留配件色等辅助信息，不参与最终物料和颜色裁决。`;
const mainEnd = `      let rows = buildDetailRows(parsed, resolvedMaterial);`;
const a = s.indexOf(mainStart);
const b = s.indexOf(mainEnd, a);
if (a < 0 || b < 0) throw new Error("missing main material block");
const end = b + mainEnd.length;
s = s.slice(0, a) + `      const linePlans = buildOrderLinePlans(text, selectionCatalog, mappings.materials);
      const allCatalogUnique = linePlans.length > 0 && linePlans.every((plan) => plan.catalogMatch.status === "unique" && plan.resolvedMaterial);
      // 以下单值仅用于兼容既有日志；实际选品严格按每个规格段自己的权威目录执行。
      const catalogMatch = linePlans[0]?.catalogMatch || { status: "none", candidates: [] };
      const resolvedMaterial = linePlans[0]?.resolvedMaterial || null;
      const ruleResolved = resolveMaterialText(parsed, mappings.materials);
      let rows = linePlans.flatMap((plan) => plan.rows);` + s.slice(end);

replaceOnce(
`        if (!resolvedMaterial || catalogMatch.status !== "unique") {`,
`        if (!allCatalogUnique) {`,
  "catalog gate"
);
replaceOnce(
`          console.log(\`已暂停：\${catalogMatch.status === "multiple" ? "权威目录存在多个候选" : "订单原文未唯一命中权威目录"}。未执行任何录入。\`);`,
`          console.log(\`已暂停：\${linePlanBlockers(linePlans).join("；") || "订单规格段未全部唯一命中权威目录"}。未执行任何录入。\`);`,
  "gate message"
);

replaceOnce(
`        const previewBlockers = [...processedOrderBlockers(text), ...parsed.issues, ...(!orderId ? ["未识别订单号"] : []), ...(!amount ? ["未识别成交金额"] : []), ...(catalogMatch.status !== "unique" ? [\`权威目录\${catalogMatch.status === "multiple" ? "存在多个候选" : "无可靠候选"}\`] : []), ...(isMultiPieceOrder(parsed) ? ["一单多件或多组尺寸暂不处理，请人工处理"] : [])];`,
`        const previewBlockers = [...processedOrderBlockers(text), ...linePlanBlockers(linePlans), ...(!orderId ? ["未识别订单号"] : []), ...(!amount ? ["未识别成交金额"] : [])];`,
  "preview blockers"
);
replaceOnce(
`      const blockers = [...new Set([...processedBlockers, ...parsed.issues, ...(!orderId ? ["未识别订单号"] : []), ...(!amount ? ["未识别成交金额"] : []), ...(catalogMatch.status !== "unique" ? [\`权威目录\${catalogMatch.status === "multiple" ? "存在多个候选" : "无可靠候选"}，暂停自动选品\`] : []), ...(isMultiPieceOrder(parsed) ? ["一单多件或多组尺寸暂不处理，请人工处理"] : [])])];`,
`      const blockers = [...new Set([...processedBlockers, ...linePlanBlockers(linePlans), ...(!orderId ? ["未识别订单号"] : []), ...(!amount ? ["未识别成交金额"] : [])])];`,
  "run blockers"
);

replaceOnce(
`              const currentRow = rows[rowIndex];
              const rowPrefix = rows.length > 1 ? \\`第 \\${rowIndex + 1}/\\${rows.length} 条明细：\\` : "";
              const materialResult = await withHumanTakeover(quote, \\`\\${rowPrefix}物料选择\\`, () => chooseMaterial(quote, resolvedMaterial.outputText, parsed, catalogMatch.match, (step, name, details) => quoteGate(step, name, \\`\\${rowPrefix}\\${details}\\`), rowIndex + 1, rows.length));
              await withHumanTakeover(quote, \\`\\${rowPrefix}明细填写与保存\\`, () => fillAndSaveDetail(quote, parsed, resolvedMaterial, quoteGate, currentRow, rowIndex + 1, rows.length, materialResult?.detailRow));`,
`              const currentRow = rows[rowIndex];
              const currentPlan = linePlans[currentRow.linePlanIndex ?? 0];
              const rowPrefix = rows.length > 1 ? \\`第 \\${rowIndex + 1}/\\${rows.length} 条明细：\\` : "";
              const materialResult = await withHumanTakeover(quote, \\`\\${rowPrefix}物料选择\\`, () => chooseMaterial(quote, currentPlan.resolvedMaterial.outputText, currentPlan.parsed, currentPlan.catalogMatch.match, (step, name, details) => quoteGate(step, name, \\`\\${rowPrefix}\\${details}\\`), rowIndex + 1, rows.length));
              await withHumanTakeover(quote, \\`\\${rowPrefix}明细填写与保存\\`, () => fillAndSaveDetail(quote, currentPlan.parsed, currentPlan.resolvedMaterial, quoteGate, currentRow, rowIndex + 1, rows.length, materialResult?.detailRow));`,
  "quote rows"
);

fs.writeFileSync(file, s, "utf8");
console.log("integrated multi-material plans");
