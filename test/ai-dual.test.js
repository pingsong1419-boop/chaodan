import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOrderText, resolveMaterialText } from "../src/parser.js";
import { compareChains, buildAiOverride, snapshotRuleChain, snapshotAiChain, runAiDualCheck } from "../src/ai-dual.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const materials = JSON.parse(fs.readFileSync(path.join(root, "data", "material-map.json"), "utf8")).materials;

function fakeAiCheck({ color = "", finishes = [], searchText = "" } = {}) {
  return { available: true, color, finishes, searchText, confidence: 0.9, evidence: "", reason: "" };
}

test("双链一致：AI 颜色与工艺均被规则链选品词包含", () => {
  const parsed = parseOrderText("6010 免钉【亮光】白色 制作宽1.71米 高1.78米");
  const resolved = resolveMaterialText(parsed, materials);
  const dual = compareChains(resolved, fakeAiCheck({ color: "白色", finishes: ["亮光"], searchText: "6010 亮光 白色" }));
  assert.equal(dual.status, "agree");
});

test("双链一致：2599288 场景复现——规则链 6010 哑光白 与 AI 哑光+白色 不再因物料编码歧义误报", () => {
  const parsed = parseOrderText("6010 免钉【哑光】白色 制作宽1.23米 高1.3米");
  const resolved = resolveMaterialText(parsed, materials);
  const dual = compareChains(resolved, fakeAiCheck({ color: "白色", finishes: ["哑光"], searchText: "6010 哑光 白色" }));
  assert.equal(dual.status, "agree");
});

test("双链一致：Pro 系列前缀豁免（8000 高精密月光白）", () => {
  const parsed = parseOrderText("8000 打孔款 Pro高精密 月光白 制作宽0.79米 高1.41米");
  const resolved = resolveMaterialText(parsed, materials);
  const dual = compareChains(resolved, fakeAiCheck({ color: "月光白", finishes: ["Pro", "高精密"], searchText: "8000 Pro 高精密 月光白" }));
  assert.equal(dual.status, "agree");
});

test("双链冲突：AI 工艺与规则链光泽不符 -> mismatch", () => {
  const parsed = parseOrderText("6010 免钉【亮光】白色 制作宽1.71米 高1.78米");
  const resolved = resolveMaterialText(parsed, materials);
  const dual = compareChains(resolved, fakeAiCheck({ color: "白色", finishes: ["哑光"], searchText: "6010 哑光 白色" }));
  assert.equal(dual.status, "mismatch");
  assert.equal(dual.aiText, "6010 哑光 白色");
  assert.match(dual.reason, /哑光/);
});

test("双链冲突：AI 颜色与规则链颜色不符 -> mismatch", () => {
  const parsed = parseOrderText("6010 免钉【亮光】白色 制作宽1.71米 高1.78米");
  const resolved = resolveMaterialText(parsed, materials);
  const dual = compareChains(resolved, fakeAiCheck({ color: "灰色", finishes: ["亮光"], searchText: "6010 亮光 灰色" }));
  assert.equal(dual.status, "mismatch");
  assert.match(dual.reason, /颜色「灰色」/);
});

test("AI 未识别到颜色 -> unverified 警示但不强制拦截", () => {
  const parsed = parseOrderText("6010 免钉【亮光】白色 制作宽1.71米 高1.78米");
  const resolved = resolveMaterialText(parsed, materials);
  const dual = compareChains(resolved, fakeAiCheck({ color: "", finishes: ["亮光"] }));
  assert.equal(dual.status, "unverified");
});

test("AI 不可用 -> skip 退化为规则单链", () => {
  const parsed = parseOrderText("6010 免钉【亮光】白色 制作宽1.71米 高1.78米");
  const resolved = resolveMaterialText(parsed, materials);
  const dual = compareChains(resolved, { available: false, error: "网络超时" });
  assert.equal(dual.status, "skip");
  assert.match(dual.reason, /网络超时/);
});

test("规则链无结果 -> skip，由既有拦截器兜底", () => {
  const dual = compareChains(null, fakeAiCheck({ color: "白色", finishes: ["亮光"] }));
  assert.equal(dual.status, "skip");
});

test("人工裁决采用 AI 链：buildAiOverride 直接以款号+工艺+颜色选品词接管", () => {
  const aiCheck = fakeAiCheck({ color: "白色", finishes: ["哑光"], searchText: "6025 哑光 白色" });
  const override = buildAiOverride(aiCheck, "6025");
  assert.equal(override.outputText, "6025 哑光 白色");
  assert.equal(override.material.searchText, "6025 哑光 白色");
  assert.equal(override.variant.modelCode, "", "AI 接管不涉及物料编码");
});

test("裁决留痕：recordDualDecision 追加 JSONL 且不覆盖历史", async () => {
  const { recordDualDecision } = await import("../src/ai-dual.js");
  const os = await import("node:os");
  const tmp = path.join(os.default.tmpdir(), `dual-test-${Date.now()}.jsonl`);
  const parsed = parseOrderText("6010 免钉【亮光】白色 制作宽1.71米 高1.78米");
  const resolved = resolveMaterialText(parsed, materials);
  const aiCheck = fakeAiCheck({ color: "白色", finishes: ["亮光"], searchText: "6010 亮光 白色" });

  recordDualDecision({
    orderId: "2599001",
    productCode: parsed.productCode,
    fragment: "6010 免钉【亮光】白色",
    rule: snapshotRuleChain(resolved),
    ai: snapshotAiChain(aiCheck),
    dual: { status: "agree", reason: "两链一致" },
    decision: { type: "confirm-agree", outputText: resolved.outputText }
  }, tmp);
  recordDualDecision({
    orderId: "2599002", productCode: "6025", fragment: "6025 免钉【哑光】白色",
    rule: snapshotRuleChain(null), ai: snapshotAiChain({ available: false, error: "超时" }),
    dual: { status: "skip", reason: "AI 不可用" }, decision: { type: "cancel" }
  }, tmp);

  const lines = fs.readFileSync(tmp, "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "两条决策应各占一行");
  const first = JSON.parse(lines[0]);
  assert.equal(first.decision.type, "confirm-agree");
  assert.ok(first.ts, "必须带时间戳");
  assert.ok(first.rule.outputText, "必须带规则链快照");
  assert.equal(first.ai.searchText, "6010 亮光 白色");
  const second = JSON.parse(lines[1]);
  assert.equal(second.decision.type, "cancel");
  assert.equal(second.ai.available, false);
  fs.unlinkSync(tmp);
});

test("快照：snapshotRuleChain / snapshotAiChain 结构完整且容忍空值", () => {
  assert.equal(snapshotRuleChain(null), null);
  const parsed = parseOrderText("8000 免打孔 淡黄[【防水】] 制作宽0.51米，高0.9米");
  const resolved = resolveMaterialText(parsed, materials);
  const snap = snapshotRuleChain(resolved);
  assert.ok(snap.outputText && snap.materialCode, "规则快照必须含选品词与物料编码");
  const aiSnap = snapshotAiChain(fakeAiCheck({ color: "淡黄", finishes: ["防水"], searchText: "8000 防水 淡黄" }));
  assert.equal(aiSnap.searchText, "8000 防水 淡黄");
  assert.deepEqual(aiSnap.finishes, ["防水"]);
  assert.equal(snapshotAiChain(null).available, false);
});

test("训练素材导出：正样本入选、取消剔除、同片段以最后一次裁决为准", async () => {
  const { buildTrainingExamples, dedupeByFragment } = await import("../ai/build-training-data.mjs");
  const rows = [
    { orderId: "1", productCode: "6010", fragment: "6010 亮光白色", rule: { outputText: "6010 亮光白", materialCode: "2701" }, decision: { type: "confirm-agree", outputText: "6010 亮光白" } },
    { orderId: "2", productCode: "6025", fragment: "6025 哑光白色", rule: { outputText: "6025 哑光白", materialCode: "2301" }, decision: { type: "ai-arbitrate", outputText: "6025 哑光 白色" } },
    { orderId: "2", productCode: "6025", fragment: "6025 哑光白色", rule: { outputText: "6025 哑光白", materialCode: "2301" }, decision: { type: "rule-arbitrate", outputText: "6025 哑光白" } },
    { orderId: "3", productCode: "8000", fragment: "8000 淡黄", decision: { type: "cancel" } },
    { orderId: "4", productCode: "", fragment: "", decision: { type: "rule-skip" } }
  ].map((r) => JSON.stringify(r));

  const { examples, stats } = buildTrainingExamples(rows);
  assert.equal(stats.total, 5);
  assert.equal(stats.cancel, 1, "取消单不计入正样本");
  assert.equal(stats.positive, 3);

  const deduped = dedupeByFragment(examples);
  assert.equal(deduped.length, 2, "同一 fragment 两次裁决只保留最后一次");
  const kept = deduped.find((e) => e.input.productCode === "6025");
  assert.equal(kept.source, "rule-arbitrate", "后一次人工拍板覆盖前一次");
});

test("AI 链冒烟：配置可用时 runAiDualCheck 返回结构化结果，不可用时不抛出", async () => {
  const result = await runAiDualCheck("6010 免钉【亮光】米白 制作宽0.62米 高1.3米", "6010");
  assert.equal(typeof result.available, "boolean");
  if (result.available) {
    assert.ok("color" in result && Array.isArray(result.finishes));
    assert.ok(result.searchText, "必须直接给出【款号+工艺+颜色】选品词");
  } else {
    assert.ok(result.error, "不可用时必须说明原因");
  }
});

test("对称比对：规则链含防水但 AI 链漏识别 -> mismatch（AI 主用时代的反向守门）", () => {
  const parsed = parseOrderText("8000 免打孔 仿亚麻灰色[【防水】] 制作宽0.495米 高1.42米");
  const resolved = resolveMaterialText(parsed, materials);
  assert.equal(resolved.outputText, "8000 防水仿亚麻灰");
  // AI 漏掉防水
  const dual = compareChains(resolved, fakeAiCheck({ color: "仿亚麻灰", finishes: [], searchText: "8000 仿亚麻灰" }));
  assert.equal(dual.status, "mismatch");
  assert.match(dual.reason, /AI 链缺少工艺「防水」/);
});

test("对称比对：AI 链补全规则链丢失的半遮光 -> mismatch（2600375 场景）", () => {
  const parsed = parseOrderText("8604 免钉 半遮光防水月光白 制作宽1.0米 高1.5米");
  const resolved = resolveMaterialText(parsed, materials);
  const dual = compareChains(resolved, fakeAiCheck({ color: "月光白", finishes: ["半遮光", "防水"], searchText: "8604 半遮光防水月光白" }));
  if (resolved && !resolved.outputText.includes("半遮光")) {
    assert.equal(dual.status, "mismatch");
    assert.match(dual.reason, /规则链缺少工艺「半遮光」/);
  } else {
    assert.equal(dual.status, "agree");
  }
});

test("AI 主用合并：选品词用 AI 链，modelCode 沿用规则链供帘罩/轨道配色", async () => {
  const { mergeAiPrimary } = await import("../src/ai-dual.js");
  const parsed = parseOrderText("8000 免打孔 仿亚麻灰色[【防水】] 制作宽0.495米 高1.42米");
  const ruleResolved = resolveMaterialText(parsed, materials);
  const aiCheck = fakeAiCheck({ color: "仿亚麻灰", finishes: ["防水"], searchText: "8000 防水仿亚麻灰" });
  const merged = mergeAiPrimary(aiCheck, ruleResolved, "8000");
  assert.equal(merged.outputText, "8000 防水仿亚麻灰", "选品词必须来自 AI 链");
  assert.equal(merged.variant.modelCode, "9019", "modelCode 必须沿用规则链推导（配件配色依赖它）");
  assert.equal(merged.material, ruleResolved.material, "物料类别沿用规则链");
});

test("AI 主用合并：规则链无结果时 AI 链独立接管", async () => {
  const { mergeAiPrimary } = await import("../src/ai-dual.js");
  const aiCheck = fakeAiCheck({ color: "拉丝银", finishes: ["拉丝"], searchText: "6010 拉丝银" });
  const merged = mergeAiPrimary(aiCheck, null, "6010");
  assert.equal(merged.outputText, "6010 拉丝银");
  assert.equal(merged.variant.modelCode, "");
});

test("脱敏片段：BY 款号不被年份截断，规格颜色完整保留", async () => {
  const { extractSpecFragment } = await import("../src/ai-dual.js");
  const raw = "20 2600271 详 改 标改 BY3009 坚美直轨 象牙白-81081 制作宽3米 侧装单轨 断开分二 2026-10-04 19:57:00 丁** 复 天猫美尔耐旗舰店 150.18 广东省中山市中山港街道博**路**号万科柏悦湾**栋***.(吴**) 改 已付款待审核";
  const fragment = extractSpecFragment(raw);
  assert.ok(fragment.includes("BY3009"), "片段必须保留 BY 款号");
  assert.ok(fragment.includes("象牙白"), "片段必须保留颜色词");
  assert.ok(!fragment.includes("中山"), "片段必须剔除地址");
});

test("脱敏片段：普通 4 位款号单行不受影响", async () => {
  const { extractSpecFragment } = await import("../src/ai-dual.js");
  const fragment = extractSpecFragment("6010 免钉【亮光】白色 制作宽0.43米 高1.03米 2026-10-01 10:00:00 浙江省杭州市西湖区某某路1号");
  assert.ok(fragment.includes("6010"));
  assert.ok(fragment.includes("白色"));
});

test("脱敏片段：备注含「7号发顺丰」不吞规格行（2600836 实盘事故）", async () => {
  const { extractSpecFragment } = await import("../src/ai-dual.js");
  const raw = "5 \n2600836\n详\n 线上预售\n改\n \n标改\n加急7号发顺丰 6010 免钉【亮光】白色;制作宽1.98米 高1.475米\n 2026-10-05 12:00:42 \n真**\n复\n天猫美尔耐旗舰店\n \n214.64\n \n上海上海市静安区北站街道北*街道**路***号新七**楼***号.(刘**)(***********)\n改\n 已付款待审核";
  const fragment = extractSpecFragment(raw, "6010");
  assert.ok(fragment.includes("6010"), "片段必须保留款号");
  assert.ok(fragment.includes("白色"), "片段必须保留颜色词");
  assert.ok(fragment.includes("亮光"), "片段必须保留工艺词");
  assert.ok(!fragment.includes("静安"), "片段必须剔除地址");
});
