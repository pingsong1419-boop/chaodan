// 训练素材导出器：把 logs/dual-chain-decisions.jsonl 的人工裁决记录
// 转换为可直接用于微调 / 少样本提示（few-shot）的训练 JSONL。
// 用法：node ai/build-training-data.mjs [决策日志路径]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const decisionsPath = process.argv[2] || path.join(root, "logs", "dual-chain-decisions.jsonl");
const reportsDir = path.join(here, "reports");

// 有人工最终拍板物料的决策类型 -> 正样本；cancel 为两链均未被认可的负样本
// 全 AI 链模式新增：confirm-ai（无对照确认 AI 链）、confirm-ai-override（冲突按 AI 链执行后人工确认录入）
// 注意：ai-auto-override 是冲突时的自动留痕（发生在 Y/N 确认之前，人工可能随后取消），不算正样本
const POSITIVE_TYPES = new Set(["confirm-agree", "rule-arbitrate", "ai-arbitrate", "rule-unverified", "rule-skip", "confirm-ai", "confirm-ai-override", "confirm-catalog"]);

export function buildTrainingExamples(lines) {
  const examples = [];
  const stats = { total: 0, positive: 0, cancel: 0, skipped: 0, byType: {} };
  for (const line of lines) {
    const text = String(line || "").trim();
    if (!text) continue;
    stats.total++;
    let rec;
    try {
      rec = JSON.parse(text);
    } catch {
      stats.skipped++;
      continue;
    }
    const type = rec.decision?.type || "unknown";
    stats.byType[type] = (stats.byType[type] || 0) + 1;
    if (type === "cancel") {
      stats.cancel++;
      continue;
    }
    if (!POSITIVE_TYPES.has(type) || !rec.fragment || !rec.productCode) {
      stats.skipped++;
      continue;
    }
    const outputText = rec.decision?.outputText || rec.rule?.outputText || "";
    const materialCode = String(rec.decision?.code || rec.rule?.materialCode || "");
    if (!outputText) {
      stats.skipped++;
      continue;
    }
    examples.push({
      input: { fragment: rec.fragment, productCode: rec.productCode },
      expected: { outputText, materialCode },
      source: type,
      orderId: rec.orderId || "",
      ts: rec.ts || ""
    });
    stats.positive++;
  }
  return { examples, stats };
}

// 去重：同一 fragment 多次裁决时，以最后一次人工拍板为准
export function dedupeByFragment(examples) {
  const byKey = new Map();
  for (const ex of examples) byKey.set(`${ex.input.productCode}::${ex.input.fragment}`, ex);
  return [...byKey.values()];
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!fs.existsSync(decisionsPath)) {
    console.log(`暂无裁决记录：${decisionsPath}\n先在日常抄单中积累人工裁决，再运行本脚本导出训练素材。`);
    process.exit(0);
  }
  const lines = fs.readFileSync(decisionsPath, "utf8").split(/\r?\n/);
  const { examples, stats } = buildTrainingExamples(lines);
  const deduped = dedupeByFragment(examples);

  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(reportsDir, `training-data-${stamp}.jsonl`);
  fs.writeFileSync(outPath, deduped.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

  console.log(`裁决记录总数: ${stats.total}（正样本 ${stats.positive} / 取消 ${stats.cancel} / 无效跳过 ${stats.skipped}）`);
  console.log(`决策分布: ${JSON.stringify(stats.byType)}`);
  console.log(`按订单片段去重后: ${deduped.length} 条训练样本`);
  console.log(`已导出: ${outPath}`);
}
