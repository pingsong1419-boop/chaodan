const norm = (v) => String(v || "")
  .replace(/[\s【】\[\]（）()·+丨|、,，/]/g, "")
  // 系统历史数据把“仿亚麻”批量录成“防亚麻”，检索时按同义词处理，原始目录保持不变。
  .replace(/防亚麻/g, "仿亚麻")
  .replace(/色$/g, "");

export function matchSelectionCatalog({ productCode, color, finishes = [], crafts = [] }, records = []) {
  if (!productCode || !color) return { status: "none", candidates: [], reason: "缺少款号或颜色" };
  const code = norm(productCode);
  const colorWord = norm(color);
  const needNoDrill = crafts.includes("免打孔") || finishes.some((x) => /免打孔|免钉|胀紧/.test(x));
  const finishWords = finishes.map(norm).filter(Boolean);
  const candidates = records.filter((r) => !r.isDisabled && norm(r.searchText).includes(code)).map((r) => {
    const text = norm(r.searchText);
    const colorText = norm(r.color);
    const candidateNoDrill = /免打孔|免钉|胀紧/.test(r.searchText);
    let score = 100;
    const reasons = ["款号匹配"];
    if (colorText.includes(colorWord) || colorWord.includes(colorText.replace(/^M-?\d+/, ""))) { score += 60; reasons.push("颜色匹配"); }
    else score -= 80;
    if (catalogColorWord(r) === colorWord) { score += 40; reasons.push("目录颜色词完全一致"); }
    if (needNoDrill === candidateNoDrill) { score += 35; reasons.push(needNoDrill ? "免打孔匹配" : "安装方式匹配"); }
    else score -= 35;
    for (const word of finishWords) {
      if (word === "免打孔" || ["梯带", "梯绳", "3.5cm", "5cm"].includes(word)) continue;
      if (text.includes(word)) { score += 12; reasons.push(`${word}匹配`); }
    }
    const exclusiveFinishes = ["哑光", "亮光", "珠光", "拉丝", "磨砂"];
    const requestedExclusive = exclusiveFinishes.filter((word) => finishWords.includes(norm(word)));
    if (requestedExclusive.length) {
      if (requestedExclusive.some((word) => text.includes(word))) score += 25;
      else if (exclusiveFinishes.some((word) => text.includes(word))) score -= 40;
    }
    for (const word of ["防水", "全遮光", "半遮光", "高遮光", "加厚", "高精密", "Pro"]) {
      if (!finishWords.includes(norm(word))) continue;
      if (!text.includes(norm(word))) score -= 20;
    }
    // 权威规格中的这些词会改变实际物料。订单没有明确要求时，不能让更高配置候选
    // （例如“防水全遮光白”）与普通“全遮光白”并列。
    for (const word of ["防水", "半遮光", "高遮光", "高精密", "Pro"]) {
      if (!finishWords.includes(norm(word)) && text.includes(norm(word))) {
        score -= 45;
        reasons.push(`订单未要求${word}`);
      }
    }
    for (const group of [["梯带", "梯绳"], ["3.5cm", "5cm"]]) {
      const requested = group.find((word) => finishWords.includes(norm(word)));
      if (!requested) continue;
      const structuralText = norm(r.color);
      const candidateValue = group.includes("3.5cm")
        ? structuralText.match(/3\.5cm|5cm/i)?.[0]
        : group.find((word) => structuralText.includes(norm(word)));
      if (candidateValue === requested) { score += 35; reasons.push(`${requested}匹配`); }
      else if (candidateValue) score -= 45;
    }
    return { ...r, score, reasons };
  }).filter((r) => r.score >= 150).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (!candidates.length) return { status: "none", candidates: [], reason: "目录中无可靠候选" };
  const top = candidates[0];
  const second = candidates[1];
  // Confirmed authoritative tie-break: the catalog contains two non-drill 5033/M-12223
  // records whose only difference is the word order of "防水/全遮光". The business
  // owner explicitly selected NE0002873 as the valid material on 2026-11-01.
  if (code === norm("5033") && !needNoDrill && colorWord === norm("薄荷") &&
      candidates.some((candidate) => candidate.id === "NE0002873" && candidate.score === top.score)) {
    const preferred = candidates.find((candidate) => candidate.id === "NE0002873");
    return {
      status: "unique",
      match: preferred,
      candidates: candidates.slice(0, 5),
      reason: `${preferred.reasons.join("、")}、权威人工裁决NE0002873`
    };
  }
  if (second && top.score - second.score < 15) return { status: "multiple", match: null, candidates: candidates.slice(0, 5), reason: "最高候选不唯一" };
  return { status: "unique", match: top, candidates: candidates.slice(0, 5), reason: top.reasons.join("、") };
}

const LOCAL_FINISHES = ["六防全遮", "全遮光", "半遮光", "高遮光", "防水", "亮光", "哑光", "亚光", "珠光", "高精密", "加厚", "拉丝", "缎纹", "立体肌理", "肌理纹", "防眩晕", "Pro"];
const NON_COLOR_WORDS = ["ProMax", ...LOCAL_FINISHES, "免打孔", "免钉", "胀紧", "打孔款", "打孔", "标致型", "豪华型", "帘罩款"];

function catalogColorWord(record) {
  let value = norm(record.color).replace(/^M-?\d+/i, "");
  for (const word of NON_COLOR_WORDS) value = value.replace(new RegExp(word, "gi"), "");
  return value
    .replace(/^(卷|柔纱帘|百叶帘)/, "")
    .replace(/^(梯带|梯绳)(?:3\.5cm|5cm)/i, "")
    .replace(/[LS]?片$/i, "")
    .replace(/色$/, "");
}

// 纯本地提取：颜色词来自权威目录本身，只接受订单原文中真实出现的目录颜色，不生成新颜色。
export function matchSelectionCatalogFromText({ productCode, rawText, crafts = [] }, records = []) {
  if (!productCode || !rawText) return { status: "none", candidates: [], reason: "缺少款号或商品原文", extracted: null };
  const raw = norm(rawText);
  const code = norm(productCode);
  const finishes = [
    ...LOCAL_FINISHES.filter((word) => raw.includes(norm(word))).map((word) => word === "亚光" ? "哑光" : word),
    ...["梯带", "梯绳", "3.5cm", "5cm"].filter((word) => raw.includes(norm(word)))
  ];
  const colorWords = records
    .filter((r) => !r.isDisabled && norm(r.searchText).includes(code))
    .map(catalogColorWord)
    .filter((word) => word && word.length >= 1 && raw.includes(word));
  const color = [...new Set(colorWords)].sort((a, b) => b.length - a.length)[0] || "";
  if (!color) return { status: "none", candidates: [], reason: "订单原文未出现权威目录颜色", extracted: { color: "", finishes } };
  return { ...matchSelectionCatalog({ productCode, color, finishes, crafts }, records), extracted: { color, finishes } };
}
