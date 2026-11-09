// 检索层：程序自己拿【款号 + 工艺 + 颜色】去物料库定位物料。
// 模型只负责说清「哪几个字是颜色、哪几个字是工艺」，检索与判定全在程序这边做，结果确定、可复现。

export function normalizeName(value) {
  return String(value || "")
    .replace(/[\s【】\[\]（）()「」·+丨|、,，/]/g, "")
    .replace(/[\d.]+/g, "")
    .trim();
}

// 物料自己的名字：searchText + candidateNames（编码取 aliases[0]）
export function ownNames(item) {
  const out = [];
  if (item.searchText) out.push(item.searchText);
  for (const n of item.candidateNames || []) out.push(n);
  return out.map((name) => ({ name, code: item.aliases?.[0] || "" }));
}

// 变体派生名：variants 的 outputText 去掉款号前缀
// 编码优先取变体自己的 modelCode —— 如 [6025] 的「哑光白」变体应报 M-2911，而不是父款号 6025
export function variantNames(item) {
  return (item.variants || [])
    .map((v) => ({
      name: String(v.outputText || "").replace(/^\S+[\s,，]/, "").trim(),
      code: String(v.modelCode || item.aliases?.[0] || "")
    }))
    .filter((entry) => entry.name);
}

function collect(materials, tokens, nameGetter) {
  const byCode = new Map();
  for (const item of materials || []) {
    if (item.status !== "confirmed") continue;
    for (const entry of nameGetter(item)) {
      const name = normalizeName(entry.name);
      if (!name || /^\d+$/.test(name)) continue;
      if (!tokens.every((t) => name.includes(t))) continue;
      // extra = 物料名比「工艺+颜色」多出来的字数，越少说明贴得越准
      const extra = name.length - tokens.reduce((sum, t) => sum + t.length, 0);
      const code = entry.code || item.aliases?.[0] || "";
      const prev = byCode.get(code);
      if (!prev || extra < prev.extra) byCode.set(code, { code, name, extra, raw: String(entry.name).trim() });
    }
  }
  const list = [...byCode.values()];
  if (!list.length) return { best: [], total: 0 };
  const minExtra = Math.min(...list.map((h) => h.extra));
  return { best: list.filter((h) => h.extra === minExtra), total: list.length };
}

function attempt(materials, tokens) {
  if (!tokens.length) return { tier: "", best: [], total: 0, mode: "无命中" };
  const own = collect(materials, tokens, ownNames);
  if (own.best.length) {
    return { tier: "精确名", best: own.best, total: own.total, mode: own.best.length === 1 ? "唯一命中" : "多命中" };
  }
  const variant = collect(materials, tokens, variantNames);
  if (variant.best.length) {
    return { tier: "变体名", best: variant.best, total: variant.total, mode: variant.best.length === 1 ? "唯一命中" : "多命中" };
  }
  return { tier: "", best: [], total: 0, mode: "无命中" };
}

function subsets(arr, size) {
  if (size === 0) return [[]];
  if (size > arr.length) return [];
  const out = [];
  const walk = (start, acc) => {
    if (acc.length === size) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      acc.push(arr[i]);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return out;
}

/**
 * 逐级放宽约束检索：
 *   第 0 级 = 颜色 + 全部工艺
 *   第 1 级 = 依次去掉 1 个工艺
 *   ...
 *   最后一级 = 只剩颜色
 * 取「第一个有命中的级别」。同一级里多个组合给出不同物料 → 视为多命中，转人工。
 */
export function retrieve(materials, { color = "", finishes = [], productCode = "" } = {}) {
  const cleanColor = normalizeName(color);
  const cleanFinishes = [...new Set((finishes || []).map(normalizeName).filter(Boolean))];
  const base = {
    tokens: [...cleanFinishes, cleanColor].filter(Boolean),
    tier: "",
    best: [],
    total: 0,
    mode: "无命中",
    dropped: [],
    relaxed: false,
    searchText: [productCode, ...cleanFinishes, cleanColor].filter(Boolean).join(" ")
  };
  if (!cleanColor && !cleanFinishes.length) return base;

  for (let drop = 0; drop <= cleanFinishes.length; drop++) {
    const combos = subsets(cleanFinishes, cleanFinishes.length - drop);
    const attempts = combos.map((keep) => ({
      keep,
      dropped: cleanFinishes.filter((f) => !keep.includes(f)),
      result: attempt(materials, [...keep, cleanColor].filter(Boolean))
    }));

    const hitAttempts = attempts.filter((a) => a.result.mode !== "无命中");
    if (!hitAttempts.length) continue;

    const uniqueOnes = hitAttempts.filter((a) => a.result.mode === "唯一命中");
    const pool = uniqueOnes.length ? uniqueOnes : hitAttempts;
    const byCode = new Map();
    for (const a of pool) for (const h of a.result.best) if (!byCode.has(h.code)) byCode.set(h.code, h);
    const best = [...byCode.values()];
    const dropped = pool[0].dropped;

    return {
      ...base,
      tier: pool[0].result.tier,
      best,
      total: pool.reduce((sum, a) => sum + a.result.total, 0),
      mode: best.length === 1 ? "唯一命中" : "多命中",
      dropped,
      relaxed: dropped.length > 0,
      searchText: [productCode, ...pool[0].keep, cleanColor].filter(Boolean).join(" ")
    };
  }

  return base;
}

export function describe(result) {
  if (!result) return "无结果";
  const tag = result.relaxed ? `放宽(丢${result.dropped.join("+")})·需复核` : "严格";
  if (result.mode === "唯一命中") return `${tag} 唯一命中 [${result.best[0].code}] ${result.best[0].name}`;
  if (result.mode === "多命中") return `${tag} 多命中 ${result.best.length} 条·转人工：${result.best.map((h) => `[${h.code}]${h.name}`).join("  ")}`;
  return "无命中·转人工";
}
