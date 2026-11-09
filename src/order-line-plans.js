import { buildDetailRows, parseOrderText, resolveMaterialText } from "./parser.js";
import { matchSelectionCatalogFromText } from "./catalog-match.js";

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

// 按每一组“款号...制作宽...高”切分。换行只作为普通空白处理，兼容网络缓存压平文本。
export function splitProductSpecSegments(rawText) {
  const text = normalize(rawText);
  const dimensions = [...text.matchAll(/(?:制作)?宽(?:度)?\s*:?\s*\d+(?:\.\d+)?\s*(?:米|m)?\s*高(?:度)?\s*:?\s*\d+(?:\.\d+)?\s*(?:米|m)?/gi)];
  if (dimensions.length <= 1) return [text];
  const codes = [...text.matchAll(/(?:^|[^\d*])((?:BY\d{2}|00[1-4]|[1-9]\d{3}|[1-2]\d{4}))(?!\d)/gi)]
    .map((match) => ({ code: match[1].toUpperCase(), index: match.index + match[0].lastIndexOf(match[1]) }));
  const starts = dimensions.map((dimension, index) => {
    const previousEnd = index ? dimensions[index - 1].index + dimensions[index - 1][0].length : 0;
    const candidates = codes.filter((entry) => entry.index >= previousEnd && entry.index < dimension.index);
    return candidates.at(-1)?.index ?? null;
  });
  // A/B 等多组尺寸只在第一组前出现一次款号，属于同一物料，不应拆成多个目录计划。
  if (starts.some((start) => start === null)) return [text];
  const segments = starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length).trim()).filter(Boolean);
  return segments.length === dimensions.length ? segments : [text];
}

export function buildOrderLinePlans(rawText, selectionCatalog, materialMappings) {
  const segments = splitProductSpecSegments(rawText);
  return segments.map((segment, index) => {
    const parsed = parseOrderText(segment);
    const catalogMatch = matchSelectionCatalogFromText({ productCode: parsed.productCode, rawText: segment, crafts: parsed.crafts }, selectionCatalog);
    const ruleResolved = resolveMaterialText(parsed, materialMappings);
    let resolvedMaterial = null;
    if (catalogMatch.status === "unique") {
      const catalogCode = catalogMatch.match.color.match(/M-(\d+)/i)?.[1] || catalogMatch.match.id;
      resolvedMaterial = {
        ...(ruleResolved || {}),
        material: ruleResolved?.material || {},
        outputText: parsed.productCode + " " + catalogCode,
        variant: { ...(ruleResolved?.variant || {}), modelCode: catalogCode, outputText: parsed.productCode + " " + catalogCode },
        catalog: catalogMatch.match
      };
    }
    const rows = buildDetailRows(parsed, resolvedMaterial).map((row) => ({ ...row, linePlanIndex: index }));
    return { index, segment, parsed, catalogMatch, resolvedMaterial, rows };
  });
}

export function linePlanBlockers(plans) {
  return plans.flatMap((plan) => {
    const prefix = plans.length > 1 ? "第" + (plan.index + 1) + "项" : "";
    const issues = plan.parsed.issues.filter((issue) => !issue.includes("独立商品规格段"));
    if (plan.catalogMatch.status !== "unique") issues.push(`权威目录${plan.catalogMatch.status === "multiple" ? "存在多个候选" : "无可靠候选"}`);
    return issues.map((issue) => prefix + issue);
  });
}
