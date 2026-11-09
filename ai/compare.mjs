import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOrderText, resolveMaterialText } from "../src/parser.js";
import { loadConfig, loadMaterials, extractSpecFragment, extractSpec } from "./ai-spec.mjs";
import { retrieve, describe } from "./retrieve.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const reportsDir = path.join(here, "reports");

// 真实订单回归样本
const CASES = [
  { id: "2599167", text: "6010 免钉【亮光】米白;制作宽 0.62米 高1.3米" },
  { id: "2596775", text: "8863 免钉 【加厚】全遮光米黄 制作宽1.06米 高1.325米" },
  { id: "2599181", text: "6010 免钉 【珠光】白色 制作宽0.675米 高1.44米" },
  { id: "2599211", text: "8000 打孔款 Pro高精密 月光白 制作宽1.0米 高2.0米" },
  { id: "2598194", text: "6025 免钉【哑光】奶油色 制作宽1.0米 高1.0米" },
  { id: "2596860", text: "8866 胀紧免打孔帘罩款 全遮光+防水丨淡黄 制作宽1.0米 高1.0米" },
  { id: "2599170", text: "8000 免打孔 淡黄[【防水】] 制作宽0.51米，高0.9米" },
  { id: "2599162", text: "8000 打孔款 仿亚麻白色[【防水】] 制作宽0.824米 高1.14米 右拉" }
];

function pad(text, width) {
  const value = String(text ?? "");
  const visual = [...value].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  return value + " ".repeat(Math.max(0, width - visual));
}

function bare(word) {
  return String(word || "").replace(/色$/, "").trim();
}

// 等价类：父款号与其变体 modelCode 指向同一实体（如 8000 的变体 7265 就等于物料 7265）
function equivalenceCodes(materials, material) {
  const codes = new Set((material?.aliases || []).map(String));
  for (const v of material?.variants || []) if (v.modelCode) codes.add(String(v.modelCode));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of materials) {
      const alias = item.aliases?.[0];
      if (!alias || !codes.has(String(alias))) continue;
      for (const v of item.variants || []) {
        if (v.modelCode && !codes.has(String(v.modelCode))) {
          codes.add(String(v.modelCode));
          changed = true;
        }
      }
    }
  }
  return codes;
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (error) {
        results[i] = { error: String(error?.message || error) };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

// 从物料库抽出全部颜色词（与 audit-coverage 同口径）
function collectColorWords(materials) {
  const words = new Set();
  for (const item of materials) {
    if (item.status !== "confirmed") continue;
    for (const v of item.variants || []) {
      const c = String(v.color || "").trim().replace(/色$/, "");
      if (c.length >= 2 && c.length <= 6) words.add(c);
    }
    const spec = String(item.searchText || "").trim();
    if (spec.length <= 8) {
      const tail = spec.match(/([\u4e00-\u9fa5]{2,4})$/)?.[1];
      if (tail && /白|灰|黑|蓝|绿|黄|粉|红|紫|金|银|橙|棕|褐|咖|米|驼|茶/.test(tail)) words.add(tail);
    }
  }
  return [...words].sort();
}

async function main() {
  const materials = loadMaterials();
  let cfg = null;
  try {
    cfg = loadConfig();
  } catch (error) {
    console.log(`[跳过 AI 部分] ${error.message}`);
  }

  console.log(`物料库：${materials.length} 条`);
  console.log(`模型：${cfg ? `${cfg.active.label || cfg.provider} (${cfg.active.model})` : "未配置"}`);
  console.log("");

  // ══ A. 8 单真实订单 ══
  const rowsA = [];
  for (const item of CASES) {
    const parsed = parseOrderText(item.text);
    const truth = resolveMaterialText(parsed, materials);
    const truthSet = equivalenceCodes(materials, truth?.material);
    const truthCode = truth?.material?.aliases?.[0] || "";
    const truthName = truth?.material?.searchText || "";

    let ai = null;
    let aiResult = null;
    let err = "";
    if (cfg) {
      try {
        const fragment = extractSpecFragment(item.text);
        ai = await extractSpec({ fragment, productCode: parsed.productCode, cfg });
        aiResult = retrieve(materials, { color: ai.color, finishes: ai.finishes, productCode: parsed.productCode });
      } catch (error) {
        err = String(error.message).slice(0, 60);
      }
    }

    const aiCodes = (aiResult?.best || []).map((h) => h.code);
    const containsTruth = aiCodes.some((c) => truthSet.has(c));
    let verdict;
    if (err) verdict = "调用失败";
    else if (aiResult?.mode === "唯一命中") verdict = containsTruth ? "一致" : "不一致";
    else if (aiResult?.mode === "多命中") verdict = containsTruth ? "多命中·含正解" : "多命中·不含正解";
    else verdict = "无命中";

    rowsA.push({
      id: item.id,
      truthCode,
      truthName,
      truthOut: truth?.outputText || "",
      aiColor: ai?.color ?? "—",
      aiFinishes: ai?.finishes?.length ? ai.finishes.join("+") : "—",
      aiSearch: err ? "—" : aiResult?.searchText ?? "—",
      aiDesc: err ? `失败：${err}` : describe(aiResult),
      dropped: aiResult?.dropped || [],
      relaxed: !!aiResult?.relaxed,
      auto: !err && aiResult?.mode === "唯一命中" && containsTruth,
      verdict
    });

    console.log(
      `${pad(item.id, 9)}真值 [${pad(truthCode, 6)}]${pad(truthName, 15)}` +
        `AI 颜色=${pad(ai?.color ?? "—", 6)} 工艺=${pad(ai?.finishes?.join("+") || "—", 12)} → ${rowsA.at(-1).verdict}`
    );
  }

  const autoA = rowsA.filter((r) => r.auto).length;
  const autoStrict = rowsA.filter((r) => r.auto && !r.relaxed).length;
  const needHuman = rowsA.filter((r) => r.verdict !== "一致").length;
  const disagree = rowsA.filter((r) => r.verdict === "不一致" || r.verdict === "多命中·不含正解" || r.verdict === "无命中");

  // ══ B. 考卷：规则处理不了的颜色词 ══
  const words = collectColorWords(materials);
  const ruleRows = words.map((word) => {
    const parsed = parseOrderText(`6010 免钉 ${word} 制作宽1米 高1米`);
    const got = (parsed.colors || [])[0] || "";
    const ruleOk = !!got && (bare(got) === bare(word) || bare(word).includes(bare(got)));
    return { word, got, ruleOk };
  });
  const problemWords = ruleRows.filter((r) => !r.ruleOk).map((r) => r.word);

  console.log("");
  console.log(`颜色词总数 ${words.length} | 规则处理不可靠 ${problemWords.length} → 作为 AI 考卷`);

  let examRows = [];
  if (cfg && problemWords.length) {
    const limit = Number(process.env.EXAM_LIMIT || problemWords.length);
    const examWords = problemWords.slice(0, limit);
    const results = await pool(examWords, 6, async (word) => {
      const ai = await extractSpec({ fragment: `6010 免钉 ${word} 制作宽1米 高1米`, productCode: "6010", cfg });
      return { word, aiColor: ai.color, confidence: ai.confidence };
    });
    examRows = results.map((r) => {
      if (r.error) return { word: "", aiColor: "", ok: false, error: r.error };
      const a = bare(r.aiColor);
      const w = bare(r.word);
      const ok = !!a && (a === w || a.endsWith(w) || w.endsWith(a));
      return { ...r, ok };
    });
    const okCount = examRows.filter((r) => r.ok).length;
    console.log(`AI 认对：${okCount} / ${examRows.length} (${((okCount / examRows.length) * 100).toFixed(0)}%)`);
  }

  // ══ 报告 ══
  const okCountB = examRows.filter((r) => r.ok).length;
  const report = [
    `# 颜色识别：规则 vs AI（真实口径）`,
    ``,
    `- 时间：${new Date().toLocaleString()}`,
    `- 模型：${cfg ? `${cfg.active.label || cfg.provider} / ${cfg.active.model}` : "未配置 API Key"}`,
    `- 物料库：${materials.length} 条`,
    `- 评分口径：不比「字符串是否与正则一致」，只比**能否命中物料库里真实存在的条目**（物料库自身即标准答案）`,
    ``,
    `## A. 8 单真实订单`,
    ``,
    `| 订单号 | 库内正确物料 | AI 识别颜色 | AI 识别工艺 | AI 路径结果 | 判定 |`,
    `|---|---|---|---|---|---|`,
    ...rowsA.map(
      (r) =>
        `| ${r.id} | \`[${r.truthCode}] ${r.truthName}\` | ${r.aiColor} | ${r.aiFinishes} | ${r.aiDesc.replace(/\|/g, "/")} | ${r.verdict} |`
    ),
    ``,
    `- **自动通过（唯一命中且正确）：${autoA} / ${rowsA.length}**（其中严格命中 ${autoStrict}，放宽约束后命中 ${autoA - autoStrict}）`,
    `- 需人工确认：${needHuman} / ${rowsA.length}`,
    ``,
    `### 需要你复核的分歧单`,
    ``,
    disagree.length
      ? disagree
          .map(
            (r) =>
              `- **${r.id}**：现有程序选 \`[${r.truthCode}] ${r.truthName}\`（检索词 \`${r.truthOut}\`），AI 选 ${r.aiDesc}`
          )
          .join("\n")
      : "（无）",
    ``,
    `## B. 考卷：规则处理不了的颜色词`,
    ``,
    `- 库内颜色词总数：${words.length}`,
    `- 规则处理不可靠（完全识别不出或认成别的颜色）：**${problemWords.length}**`,
    `- 交给 AI 重认后：**${examRows.length ? `${okCountB} / ${examRows.length}（${((okCountB / examRows.length) * 100).toFixed(0)}%）` : "未运行"}**`,
    ``,
    examRows.length
      ? [
          `| 订单里的颜色词 | AI 识别为 | 结果 |`,
          `|---|---|---|`,
          ...examRows.map((r) => `| \`${r.word}\` | \`${r.aiColor || "(空)"}\` | ${r.ok ? "对" : "错"} |`)
        ].join("\n")
      : "（未运行）",
    ``,
    `## 说明`,
    ``,
    `1. AI 不再从固定词表里挑词，只做两件事：指出**哪几个字是颜色**、**哪几个字是工艺面料**；安装方式（免钉/免打孔/打孔/胀紧/帘罩款）一律丢弃。`,
    `2. 组装检索词与回查物料库由程序完成（\`ai/retrieve.mjs\`），模型不参与「猜物料」。`,
    `3. 检索分档：严格唯一命中 → 自动通过；同一级别多组合给出不同物料 → 多命中，沿用现有单选守门员转人工；无命中 → 逐级放宽（依次丢掉工艺词）重试，命中则标「放宽·需复核」。`,
    `4. 本脚本只读 \`data/material-map.json\` 与 \`ai/config.json\`，**不修改 \`src/\` 下任何文件**。`,
    ``
  ].join("\n");

  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(reportsDir, `compare-${stamp}.md`);
  fs.writeFileSync(outPath, report, "utf8");

  console.log("──────────────────────────────────────────────");
  console.log(`A 自动通过：${autoA} / ${rowsA.length}（严格 ${autoStrict}）  需人工：${needHuman} / ${rowsA.length}`);
  console.log(`B AI 认对：${examRows.length ? `${okCountB} / ${examRows.length}` : "未运行"}`);
  console.log(`报告：${outPath}`);
}

main().catch((error) => {
  console.error(`评测脚本失败：${error.message}`);
  console.error(error.stack);
  process.exitCode = 1;
});
