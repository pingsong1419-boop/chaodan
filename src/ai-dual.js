// 双链校验桥：规则链(parser.js) 与 AI 链(ai/ai-spec.mjs) 并行判定同一订单。
// AI 链只负责识别「哪几个字是颜色、哪几个字是工艺」，直接拼成【款号 + 工艺 + 颜色】选品词；
// 不查物料编码（款号必然在订单信息里，报价单选品弹窗按中文词直达）。
// 当前为全 AI 链模式：选品词完全由 AI 链决定；规则链仅静默推导 modelCode/类别供帘罩轨道配色，
// compareChains 结果只用于日志对照与训练素材留痕，不再触发人工裁决。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, extractSpecFragment, extractSpec } from "../ai/ai-spec.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultDecisionLogPath = path.join(here, "..", "logs", "dual-chain-decisions.jsonl");

export { extractSpecFragment };

let aiConfig = null;
let aiConfigError = null;

export function getAiConfig() {
  if (aiConfig || aiConfigError) return { cfg: aiConfig, error: aiConfigError };
  try {
    aiConfig = loadConfig();
  } catch (error) {
    aiConfigError = error.message;
  }
  return { cfg: aiConfig, error: aiConfigError };
}

/**
 * 对单条订单文本执行 AI 链抽取（颜色 + 工艺 → 直接拼选品词，不查物料编码）。
 * AI 不可用（未配置 Key / 网络失败 / 超时）时 available=false，绝不抛出中断主流程。
 */
export async function runAiDualCheck(orderText, productCode) {
  const { cfg, error } = getAiConfig();
  if (!cfg) return { available: false, error: error || "AI 未配置" };
  try {
    const fragment = extractSpecFragment(orderText, productCode || "");
    const spec = await extractSpec({ fragment, productCode: productCode || "", cfg });
    return { available: true, ...spec };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

// 规格词归一：去空白/括号/分隔符，词尾「色」归一（白色↔白）
function normToken(value) {
  return String(value || "")
    .replace(/[\s【】\[\]（）()「」·+丨|、,，/]/g, "")
    .replace(/色$/, "");
}

// 规则链规格段中可能出现的工艺词表（用于反向核对 AI 链是否遗漏）
const FINISH_WORDS = ["六防全遮", "全遮光", "半遮光", "高遮光", "防水", "亮光", "哑光", "珠光", "高精密", "加厚", "拉丝", "缎纹", "立体肌理", "肌理纹", "防眩晕"];

// 规则链选品词的规格段（去掉开头款号）
function ruleSpecOf(resolvedMaterial) {
  return normToken(String(resolvedMaterial?.outputText || "").replace(/^\S+[\s,，]?/, ""));
}

/**
 * 比对两条链的选品词（对称双向核对）：
 *   1. 规则链规格段必须包含 AI 识别的颜色与全部工艺词；
 *   2. 规则链规格段中出现的工艺词，AI 链选品词也必须包含（防止 AI 漏识别）；
 *   Pro 为系列前缀，双向豁免；词尾「色」归一。
 * status:
 *   agree      两链选品词一致
 *   mismatch   任一方向存在差异（全 AI 链模式下仅留痕，自动按 AI 链执行）
 *   unverified AI 未识别到颜色，无法佐证 -> 警示（全 AI 链模式下本单会暂停）
 *   skip       AI 链不可用或规则链本身无结果
 */
export function compareChains(resolvedMaterial, aiCheck) {
  if (!aiCheck?.available) return { status: "skip", reason: aiCheck?.error || "AI 链不可用" };
  if (!resolvedMaterial) return { status: "skip", reason: "规则链无物料结果" };

  const aiText = aiCheck.searchText || "";
  const color = normToken(aiCheck.color);
  if (!color) return { status: "unverified", reason: "AI 链未能识别到颜色，无法复核规则链结果", aiText };

  const ruleSpec = ruleSpecOf(resolvedMaterial);
  const aiSpec = normToken(aiText).replace(/^\d+/, "");
  const aiFinishes = (aiCheck.finishes || []).map(normToken).filter((f) => f && f !== "Pro");
  const ruleFinishes = FINISH_WORDS.filter((w) => ruleSpec.includes(w));

  const missing = [];
  if (!ruleSpec.includes(color)) missing.push(`规则链缺少颜色「${aiCheck.color}」`);
  for (const f of aiFinishes) if (!ruleSpec.includes(f)) missing.push(`规则链缺少工艺「${f}」`);
  for (const f of ruleFinishes) if (!aiSpec.includes(f)) missing.push(`AI 链缺少工艺「${f}」`);

  if (!missing.length) {
    return { status: "agree", reason: `两链选品词一致（${aiText || resolvedMaterial.outputText}）`, aiText };
  }
  return {
    status: "mismatch",
    reason: `规则链「${resolvedMaterial.outputText}」与 AI 链「${aiText}」不一致：${missing.join("；")}`,
    aiText
  };
}

// 人工裁决采用 AI 链时，直接用【款号 + 工艺 + 颜色】选品词接管后续流程（不涉及物料编码）
export function buildAiOverride(aiCheck, productCode) {
  const outputText = aiCheck.searchText
    || [productCode, [...(aiCheck.finishes || []), aiCheck.color].filter(Boolean).join("")].filter(Boolean).join(" ");
  return {
    material: { searchText: outputText, aliases: [], status: "confirmed", productCategory: "AI链裁决" },
    variant: { modelCode: "", outputText },
    outputText
  };
}

// AI 链主用接管：选品词用 AI 链；物料类别与帘罩/轨道配色所需的 modelCode 沿用规则链推导结果
export function mergeAiPrimary(aiCheck, ruleResolved, productCode) {
  const o = buildAiOverride(aiCheck, productCode);
  return {
    ...o,
    material: ruleResolved?.material || o.material,
    variant: { modelCode: ruleResolved?.variant?.modelCode || "", outputText: o.outputText }
  };
}

// ========================= 人工裁决留痕（训练素材积累） =========================

export function snapshotRuleChain(resolvedMaterial) {
  if (!resolvedMaterial) return null;
  return {
    outputText: resolvedMaterial.outputText || "",
    materialCode: String(resolvedMaterial.variant?.modelCode || resolvedMaterial.material?.aliases?.[0] || ""),
    category: resolvedMaterial.material?.productCategory || ""
  };
}

export function snapshotAiChain(aiCheck) {
  if (!aiCheck?.available) return { available: false, error: aiCheck?.error || "" };
  return {
    available: true,
    color: aiCheck.color || "",
    finishes: aiCheck.finishes || [],
    confidence: aiCheck.confidence ?? 0,
    evidence: aiCheck.evidence || "",
    reason: aiCheck.reason || "",
    searchText: aiCheck.searchText || ""
  };
}

/**
 * 追加一条双链判定与人工决策记录（JSONL，每行一条）。
 * decision.type 取值：
 *   confirm-agree       两链一致，人工按 Y 确认
 *   confirm-ai          无对照（skip/unverified），人工按 Y 确认 AI 链
 *   ai-auto-override    双链冲突，全 AI 链模式自动采用 AI 链（不再人工裁决）
 *   confirm-ai-override 双链冲突按 AI 链执行后，人工按 Y 确认录入
 *   rule-arbitrate / ai-arbitrate  历史人工裁决记录（旧模式遗留）
 *   rule-unverified / rule-skip    历史规则链兜底记录（旧模式遗留）
 *   cancel           人工取消本单（两链均未被认可，负样本）
 *   preview-*        预览模式(try)中的对应决策，不进入训练素材
 */
export function recordDualDecision(entry, filePath = defaultDecisionLogPath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch { }
}
