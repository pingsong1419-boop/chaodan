import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultKnowledgePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "knowledge-rules.json");
let defaultKnowledgeRules = null;
try {
  if (fs.existsSync(defaultKnowledgePath)) {
    defaultKnowledgeRules = JSON.parse(fs.readFileSync(defaultKnowledgePath, "utf8"));
  }
} catch {
  defaultKnowledgeRules = null;
}

function normalize(value) {
  return String(value ?? "").replace(/[，、；]/g, ",").replace(/[：]/g, ":").replace(/\s+/g, " ").trim();
}

function capture(text, expressions) {
  for (const expression of expressions) {
    const match = text.match(expression);
    if (match) return match[1];
  }
  return null;
}

function dimension(text, marker) {
  const value = capture(text, [new RegExp(`(?:制作)?${marker}(?:度)?\\s*:?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:米|m)?`, "i")]);
  return value === null ? null : Number(value);
}

function extractRemark(rawText, productCode) {
  const lines = String(rawText ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const source = lines.find((line) =>
    (!productCode || line.includes(productCode)) && /(?:制作)?宽/.test(line) && /(?:制作)?高/.test(line)
  ) || normalize(rawText);
  const heights = [...source.matchAll(/(?:制作)?高(?:度)?\s*:?\s*\d+(?:\.\d+)?\s*(?:米|m)?/gi)];
  const height = heights.at(-1);
  if (!height) return "";
  let rem = source.slice(height.index + height[0].length);
  // 截断在表格下一列的下单时间 (如 2026-10-01 20:13:45) 或店铺信息之前
  rem = rem.split(/\b202[4-9]-\d{2}-\d{2}/)[0];
  rem = rem.split(/(?:旗舰店|专卖店|专营店)/)[0];
  return rem
    .replace(/(?:数量|共|做)\s*:?\s*\d+\s*(?:个|件|片|套|樘)?/g, " ")
    .replace(/\d+\s*(?:个|件|片|套|樘)/g, " ")
    .replace(/一个左.{0,8}一个右(?:拉珠)?|一左一右(?:拉珠)?|左(?:拉珠|控|边|侧)|右(?:拉珠|控|边|侧)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseAmount(value) {
  const text = String(value ?? "").replace(/,/g, "");
  const labeled = text.match(/(?:成交金额|已付金额|实付金额|付款金额)\s*:?\s*(\d+(?:\.\d+)?)/)?.[1];
  if (labeled) return labeled;
  const afterShop = text.match(/(?:旗舰店|专卖店|专营店)\s+(\d+(?:\.\d+)?)/)?.[1];
  if (afterShop) return afterShop;
  const amountOnly = text.trim().match(/^(\d+(?:\.\d+)?)\s*元?$/)?.[1];
  if (amountOnly) return amountOnly;
  return null;
}

export function detectDoNotCopyInstruction(rawText) {
  const text = String(rawText || "").replace(/\s+/g, "");
  return /(?:暂不|暂时不|先不|不要|勿|禁止|严禁|暂停|无需)抄(?:单)?|(?:暂不|暂时不|先不|不要|勿|禁止|暂停)录(?:入|单)?|等(?:客服|客户)?通知(?:后|再)?(?:制作|做|生产)?|通知后(?:再)?(?:制作|做|生产)/.test(text);
}

export function validateProductionLimits(productCode, width, height, crafts, text, rules = defaultKnowledgeRules) {
  // 2026-11-06 用户确认：尺寸、面积没有权威限制来源，不作为抄单拦截条件。
  // 解析、确认卡片和报价单仍保留原始宽高，只取消上下限与面积判断。
  return [];
}

export function parseOrderText(rawText, rules = defaultKnowledgeRules) {
  const text = normalize(rawText);
  // 结构化订单文本会同时包含成交金额和商品售价。它们常为 4 位整数
  // （如“已付金额: 1676.11”或“￥1299”），不能参与款号识别。
  const productCodeText = text
    .replace(/已付金额\s*[:：]?\s*[￥¥]?\s*\d+(?:\.\d+)?/gi, " ")
    .replace(/[￥¥]\s*\d+(?:\.\d+)?/g, " ")
    .replace(/满\s*\d{3,5}.{0,16}?(?:抵扣|减免|优惠|赠送|送)/g, " ");
  const productCode = capture(productCodeText, [
    /(?:^|[^\w])(?:型号|款号|代号)?\s*(BY\d{2})(?!\w)/i,
    /(?:^|[^\d*])(?:型号|款号|代号)?\s*(00[1-4])(?!\d)/,
    /(?:^|[^\d*])(?:型号|款号|代号)?\s*(?!(?:202[0-9]|203[0-9])(?:[-\/年]|\b))([1-9]\d{3})(?!\d)/,
    /(?:^|[^\d*])(?:型号|款号|代号)?\s*([1-2]\d{4})(?!\d)/
  ])?.toUpperCase() || null;

  const productLines = String(rawText ?? "").split(/\r?\n/).filter((line) =>
    (!productCode || line.includes(productCode)) && /(?:制作)?宽/.test(line) && /(?:制作)?高/.test(line)
  );
  const productLine = productLines.length ? productLines.join(" ") : text;
  // 赠品/辅料数量与名称不能污染产品件数、颜色或工艺（如“送打孔支架2个”）。
  const specText = text.replace(/(?:赠送?|送)\s*(?:\d+\s*(?:个|件|片|套)\s*)?(?:打孔)?(?:支架|垫片|配件|螺丝|赠品)\s*\d*\s*(?:个|件|片|套)?/g, " ");
  const dimensionMatches = [...productLine.matchAll(/(?:制作)?宽(?:度)?\s*:?\s*(\d+(?:\.\d+)?)\s*(?:米|m)?\s*高(?:度)?\s*:?\s*(\d+(?:\.\d+)?)\s*(?:米|m)?/gi)];
  const productCodeOccurrences = productCode ? text.toUpperCase().split(productCode).length - 1 : 0;
  const hasMultipleProductSegments = productLines.length > 1 || (dimensionMatches.length > 1 && productCodeOccurrences > 1);
  const dimensionPairs = dimensionMatches.map((match) => ({ width: Number(match[1]), height: Number(match[2]) }));
  const detailGroups = dimensionMatches.map((match, index) => {
    const end = dimensionMatches[index + 1]?.index ?? productLine.length;
    const segment = productLine.slice(match.index, end);
    const groupQuantity = Number(capture(segment, [/(?:数量|共|做)\s*:?\s*(\d+)/, /(\d+)\s*(?:个|件|片|套|樘)/]) ?? 1);
    let groupSides = [];
    if (/左右拉|一左一右|一个左.{0,8}一个右/.test(segment) && groupQuantity === 2) groupSides = ["左拉珠", "右拉珠"];
    else if (/左(?:拉珠|控|边|侧)?/.test(segment) && !/右(?:拉珠|控|边|侧)?/.test(segment)) groupSides = Array(groupQuantity).fill("左拉珠");
    else if (/右(?:拉珠|控|边|侧)?/.test(segment) && !/左(?:拉珠|控|边|侧)?/.test(segment)) groupSides = Array(groupQuantity).fill("右拉珠");
    return { width: Number(match[1]), height: Number(match[2]), quantity: groupQuantity, sides: groupSides };
  });
  const width = dimensionPairs[0]?.width ?? dimension(text, "宽");
  const height = dimensionPairs[0]?.height ?? dimension(text, "高");
  const quantityText = specText;
  let quantity = Number(capture(quantityText, [/(?:数量|共|做)\s*:?\s*(\d+)/, /(\d+)\s*(?:个|件|片|套|樘)/]) ?? 1);
  if (detailGroups.length > 1) quantity = detailGroups.reduce((sum, group) => sum + group.quantity, 0);
  if (/一个左.{0,8}一个右|一左一右/.test(specText)) quantity = 2;
  let sides = Array(quantity).fill("");
  if (/一个左.{0,8}一个右|一左一右/.test(specText)) sides = ["左拉珠", "右拉珠"];
  else if (/左(?:拉珠|控|边|侧)?/.test(specText) && !/右(?:拉珠|控|边|侧)?/.test(specText)) sides.fill("左拉珠");
  else if (/右(?:拉珠|控|边|侧)?/.test(specText) && !/左(?:拉珠|控|边|侧)?/.test(specText)) sides.fill("右拉珠");

  const colors = [];
  const colorPatterns = [
    // 1. 米黄与黄色系
    [/米黄(?:色)?|浅米黄|深米黄|栀子黄|阳光黄|茉莉黄|沙黄|杏黄/, "米黄色"],
    [/淡黄(?:色)?|浅黄(?:色)?|奶黄(?:色)?/, "淡黄色"],
    [/(?<![淡浅奶米阳光栀子金杏沙])黄色|金黄色?|明黄|姜黄/, "黄色"],

    // 2. 米白与白色系
    [/月光白(?:色)?/, "月光白"],
    [/【?珠光】?\s*白色?|珠光白/, "珠光白"],
    [/【?珠光】?\s*米白/, "珠光米白"],
    [/【?珠光】?\s*(?:果)?绿/, "珠光绿色"],
    [/米白(?:色)?|珍珠白|典雅白|雪山白|贝母白|雅白|仿麻白/, "米白色"],
    [/象牙白(?:色)?/, "白色"],
    [/素白|厚云白|暖云白|雪绒白|菱花白|素雅白|初晨白|云雾白|轻雾白|星沙白|棉云白|蛋霜白|云朵白/, "素白"],
    [/奶油色|奶白|奶杏(?:色)?|法式杏|奶油杏|香草奶油|嫩杏白/, "奶油色"],
    [/(?<![米素奶雪贝雅轻尊珍珠仿])白色|雪白|纯白|白蜡|轻纱白|尊贵白/, "白色"],

    // 3. 灰色系
    [/浅灰(?:色)?|薄雾灰|清雅灰|晨曦灰|海豚灰|淡雅灰|薄暮灰/, "浅灰色"],
    [/深灰(?:色)?|深空灰|太空灰|烟灰|暗灰|曼午灰|迷雾灰|云烟灰|烟墨灰|深海鸥灰/, "深灰色"],
    [/(?<![浅深暗烟钛雾氟布海晨薄云轻银高级西装星空])灰色/, "灰色"],

    // 4. 黑色系
    [/深空黑|暗夜黑|极光黑|磨砂黑|爵士黑|浩瀚黑|雅致黑|黑色|雅黑/, "黑色"],

    // 5. 蓝色系
    [/淡蓝(?:色)?|浅蓝(?:色)?|海盐蓝/, "淡蓝色"],
    [/(?<![淡浅])深蓝(?:色)?|天蓝|克莱因蓝|优雅蓝|孔雀蓝|海青蓝|蓝色/, "蓝色"],

    // 6. 绿色系
    [/浅绿(?:色)?|淡绿(?:色)?|时光绿/, "浅绿色"],
    [/果绿(?:色)?|薄荷(?:绿|色)?|松石绿|清湖绿|抹茶|中古绿|深绿|墨绿|(?<![浅淡果深墨])绿色/, "绿色"],

    // 7. 粉色/红色/橙色系
    [/波普粉/, "波普粉"],
    [/粉色|梦幻粉/, "粉色"],
    [/深红|酒红|玫瑰|樱桃|红色/, "红色"],
    [/橙漫落日|落日色|晚霞色|橙色/, "橙色"],

    // 8. 紫色系
    [/紫色|紫罗兰|高贵紫/, "紫色"],

    // 9. 棕/木纹/胡桃/咖色系
    [/褐色|深褐|浅褐/, "褐色"],
    [/奶茶色|焦糖色/, "奶茶色"],
    [/咖啡色|深咖|浅咖|奶咖(?:色)?|可可棕|中古咖|巧克力咖|拿铁|落栗|咖色|摩卡/, "咖啡色"],
    [/琥珀棕|枫糖棕|棕色/, "棕色"],
    [/胡桃(?:木)?|黑胡桃|红木|红橡|原木|苍木|柚木|梨树|雾桦/, "胡桃色"],

    // 10. 香槟/金色/银色系
    [/香槟金|香槟色/, "香槟色"],
    [/(?<![成定定实已付])金色/, "金色"],
    [/亮光银|亮银|闪光银|钛灰银/, "亮光银色"],
    [/银色|银灰|金属银|尊贵银/, "银色"],
    [/月瓷白/, "月瓷白"],

    // 11. 卡其/驼色/米色系
    [/卡其(?:色)?|燕麦/, "卡其色"],
    [/驼色|浅驼/, "驼色"],
    [/淡雅米|商务米|奶油米|淡奶米|米肉|肉色|奶沙杏|暖杏|(?<![0-9\.\s])米色/, "米色"]
  ];
  for (const [pattern, value] of colorPatterns) {
    if (pattern.test(specText)) colors.push(value);
  }

  // 去重并处理包含关系：若同时命中深灰/浅灰，则排除通用灰色
  let filteredColors = [...new Set(colors)];
  if (filteredColors.includes("珠光白") || filteredColors.includes("珠光米白") || filteredColors.includes("月光白")) {
    filteredColors = filteredColors.filter((c) => c !== "白色" && c !== "素白");
  }
  if (filteredColors.includes("深灰色") || filteredColors.includes("浅灰色")) {
    filteredColors = filteredColors.filter((c) => c !== "灰色");
  }
  if (filteredColors.includes("淡黄色") || filteredColors.includes("米黄色")) {
    filteredColors = filteredColors.filter((c) => c !== "黄色");
  }
  if (filteredColors.includes("淡蓝色")) {
    filteredColors = filteredColors.filter((c) => c !== "蓝色");
  }
  if (filteredColors.includes("浅绿色")) {
    filteredColors = filteredColors.filter((c) => c !== "绿色");
  }

  const crafts = [];
  const craftPatterns = [
    [/免打孔|免钉|无痕|胀紧/, "免打孔"],
    [/哑光|亚光/, "哑光"],
    [/亮光/, "亮光"],
    [/珠光/, "珠光"],
    [/(?<!免)打孔/, "打孔"],
    [/防水/, "防水"],
    [/全遮光|高遮光/, "全遮光"],
    [/半遮光/, "半遮光"],
    [/一拉防风|防风/, "防风"],
    [/弹簧半自动|半自动/, "半自动"],
    [/日夜蜂巢|日夜帘/, "日夜帘"],
    [/电动/, "电动"],
    [/手动/, "手动"],
    [/豪华型帘罩|豪华帘罩|豪华型/, "豪华型"],
    [/标致型帘罩|标致帘罩|标致型/, "标致型"],
    [/豪华轨/, "豪华轨"],
    [/无拉绳轨|无拉绳/, "无拉绳"]
  ];
  for (const [pattern, value] of craftPatterns) {
    if (pattern.test(specText)) crafts.push(value);
  }

  const issues = [];
  if (!productCode) issues.push("未识别产品代号");
  if (hasMultipleProductSegments) issues.push(`一单包含${dimensionMatches.length}个独立商品规格段，且可能使用不同物料，暂不自动抄单`);
  if (width === null) issues.push("未识别宽度");
  if (height === null) issues.push("未识别高度");
  if (/电动/.test(specText)) issues.push("电动产品暂不处理，不能抄单");
  if (/等待订单合并/.test(text)) issues.push("订单等待合并，不能抄单");
  else if (/(?:^|\s)异常(?:\s|$)/.test(text)) issues.push("订单状态异常，不能抄单");
  if (/L型|U型|异型|八角窗|天窗|内开窗|超高/.test(text)) issues.push("复杂窗型，需要人工复核");

  const limitIssues = validateProductionLimits(productCode, width, height, crafts, text, rules);
  issues.push(...limitIssues);

  const isDeluxeHood = /豪华(?:型)?(?:帘罩|罩壳)/.test(text) || crafts.includes("豪华型");
  const isStandardHood = /标致(?:型)?(?:帘罩|罩壳)/.test(text) || crafts.includes("标致型");
  const isClampHood = /胀紧/.test(text);
  const isCordlessTrack = /无拉绳/.test(text) || crafts.includes("无拉绳");
  const isDeluxeTrack = /豪华轨/.test(text) || crafts.includes("豪华轨");

  let hoodOption = null;
  if (isDeluxeHood) hoodOption = "豪华型帘罩";
  else if (isStandardHood || isClampHood) hoodOption = isClampHood ? "胀紧标致帘罩" : "标致型帘罩";

  let trackOption = null;
  if (isCordlessTrack) trackOption = "无拉绳轨";
  else if (isDeluxeTrack) trackOption = "豪华轨";

  if (hoodOption && hoodOption.includes("标致") && (/香格里拉/.test(text) || /依云/.test(text))) {
    issues.push("香格里拉/依云帘不支持标致型帘罩，仅支持豪华型");
  }

  const remark = extractRemark(rawText, productCode);
  return {
    rawText,
    normalizedText: text,
    productCode,
    colors: filteredColors,
    crafts: [...new Set(crafts)],
    width,
    height,
    dimensionPairs,
    detailGroups,
    quantity,
    sides,
    hoodOption,
    trackOption,
    remark,
    issues,
    confidence: Math.max(0, 1 - issues.length * 0.2)
  };
}

export function resolveHoodAndTrackColor(modelCode, hoodOption, trackOption, rules = defaultKnowledgeRules) {
  if (!rules || !modelCode) return { hoodColor: null, trackColor: null };
  const cleanCode = String(modelCode).replace(/^[Mm]-?/, "").trim();

  let hoodColor = null;
  let trackColor = null;

  if (hoodOption) {
    const hoodEntry = rules.hoodRules?.[cleanCode];
    if (hoodEntry) {
      if (hoodOption === "豪华型帘罩") {
        hoodColor = hoodEntry.deluxeHood !== "/" ? hoodEntry.deluxeHood : null;
      } else if (hoodOption.includes("标致")) {
        let std = hoodEntry.standardHood !== "/" ? hoodEntry.standardHood : null;
        if (hoodOption === "胀紧标致帘罩") {
          if (std && !rules.clampStandardAllowedColors?.includes(std)) {
            std = "米白11#";
          }
        }
        hoodColor = std;
      }
    }
  }

  if (trackOption) {
    const trackEntry = rules.honeycombTrackRules?.[cleanCode];
    if (trackEntry) {
      if (trackOption === "豪华轨") trackColor = trackEntry.deluxeTrack || null;
      else if (trackOption === "无拉绳轨") trackColor = trackEntry.cordlessTrack || null;
    }
  }

  return { hoodColor, trackColor };
}

export function buildDetailRows(parsed, resolvedMaterial = null, rules = defaultKnowledgeRules) {
  const hasMixedSides = parsed.sides?.includes("左拉珠") && parsed.sides?.includes("右拉珠");
  const hasStructuredGroups = parsed.detailGroups?.length >= 1;
  const dimensions = hasStructuredGroups
    ? parsed.detailGroups.flatMap((group) => {
      if (group.sides?.length === group.quantity) {
        return group.sides.map((side) => ({ width: group.width, height: group.height, quantity: 1, side }));
      }
      return [{ width: group.width, height: group.height, quantity: group.quantity, side: group.sides?.[0] || "" }];
    })
    : parsed.dimensionPairs?.length > 1
    ? parsed.dimensionPairs.map((pair, index) => ({ ...pair, quantity: 1, side: parsed.sides?.[index] || "" }))
    : hasMixedSides
      ? parsed.sides.map((side) => ({ width: parsed.width, height: parsed.height, quantity: 1, side }))
      : [{ width: parsed.width, height: parsed.height, quantity: Number(parsed.quantity || 1), side: parsed.sides?.[0] || "" }];

  const modelCode = resolvedMaterial?.variant?.modelCode || resolvedMaterial?.aliases?.[0] || "";
  const { hoodColor, trackColor } = resolveHoodAndTrackColor(modelCode, parsed.hoodOption, parsed.trackOption, rules);

  // 报价单备注只记录非默认拉珠方向：普通产品默认右拉；5002 默认双拉珠。
  const pullRemark = (side) => {
    const remarks = [];
    const raw = String(parsed.rawText || "").replace(/\s+/g, " ");
    const addRemark = (value) => {
      const clean = String(value || "").replace(/[，,;；。]+$/g, "").trim();
      if (clean && !remarks.includes(clean)) remarks.push(clean);
    };
    if (parsed.productCode === "5002") {
      if (side === "左拉珠") addRemark("左单拉");
      else if (side === "右拉珠") addRemark("右单拉");
    } else if (side === "左拉珠") {
      addRemark("左拉");
    }
    if (/两头装/.test(raw)) addRemark("两头装");
    if (/(?:不要|不需要|无|去掉?)\s*(?:logo|标志|商标)/i.test(raw)) addRemark("不要LOGO");
    if (/(?:只要|仅要|只做)\s*(?:帘布|布)(?:不要轨道)?/.test(raw) || /不要轨道/.test(raw)) addRemark("只要帘布");
    if (/加急/.test(raw)) addRemark("加急");
    for (const match of raw.matchAll(/(?:\d{1,2}月\d{1,2}(?:日|号)?|\d{1,2}[-\/.]\d{1,2}(?:日|号)?|今天|明天|后天)(?:之前|以前|前|当天)?(?:安排)?(?:发货|发出|发)/g)) addRemark(match[0]);
    for (const match of raw.matchAll(/收起(?:来)?(?:的)?(?:厚度|高度)\s*(?:要|为|是)?\s*\d+(?:\.\d+)?\s*(?:厘米|公分|cm)/gi)) addRemark(match[0]);
    if (/拉珠(?:和|与)?帘布(?:配色|同色|颜色一致|颜色一样|一样)/.test(raw)) addRemark("拉珠和帘布配色");
    if (/同一(?:面|平面)|同个平面|一个平面|同面/.test(raw)) addRemark("同一面");
    return remarks.join(" ");
  };

  return dimensions.map((size, index) => {
    const accessories = [];
    if (parsed.hoodOption && hoodColor) accessories.push(`${parsed.hoodOption}: ${hoodColor}`);
    if (parsed.trackOption && trackColor) accessories.push(`${parsed.trackOption}: ${trackColor}`);
    const accessoryText = accessories.join("; ");

    return {
      row: index + 1,
      productCode: parsed.productCode,
      color: parsed.colors[0] ?? "",
      crafts: parsed.crafts,
      width: size.width,
      height: size.height,
      quantity: size.quantity || 1,
      side: size.side || "",
      hoodColor,
      trackColor,
      remark: pullRemark(size.side || parsed.sides[index] || "")
    };
  });
}

function normalizeSpecWord(word) {
  return String(word || "")
    .replace(/白色$/, "白")
    .replace(/灰色$/, "灰")
    .replace(/蓝色$/, "蓝")
    .replace(/黄色$/, "黄")
    .replace(/绿色$/, "绿")
    .replace(/黑色$/, "黑")
    .replace(/褐色$/, "褐")
    .replace(/紫色$/, "紫")
    .replace(/粉色$/, "粉")
    .replace(/红色$/, "红")
    .replace(/金色$/, "金")
    .replace(/银色$/, "银")
    .replace(/米色$/, "米")
    .replace(/驼色$/, "驼")
    .replace(/咖色$/, "咖")
    .trim();
}

function extractChineseSpec(rawText, parsed, item) {
  // 仅在当前款号所在行且款号后面的文本范围内提取，防止跨款号污染
  const fullText = parsed.normalizedText || rawText || "";
  let relevantText = fullText;
  if (parsed.productCode && fullText.includes(parsed.productCode)) {
    const afterCode = fullText.split(parsed.productCode)[1] || "";
    relevantText = afterCode.split(/制作宽|宽\s*\d|\b\d{4}\b/)[0] || afterCode;
  }

  // 1. 优先匹配复合面料特征词：仿亚麻/细麻/粗麻/高精密
  const fabricMatch = relevantText.match(/(仿亚麻|细麻|粗麻|高精密)\s*(月光白|米白|深空灰|白|灰|黑|淡黄|米黄|深灰|褐|米)?(?:色)?/);
  if (fabricMatch) {
    const p1 = fabricMatch[1];
    let p2 = fabricMatch[2] || "";
    if (p1 === "仿亚麻" && !p2) p2 = "白";
    if (p1 === "细麻" && !p2) p2 = "米白";
    if (p1 === "粗麻" && !p2) p2 = "米白";
    const fabricSpec = `${p1}${p2}`;
    // 功能性工艺前缀保留：仅当订单标注了该工艺且目标物料名称同时包含该工艺与面料词
    // （如订单写【防水】且目标物料为 9019 防水仿亚麻灰 -> 直出 防水仿亚麻灰；
    //  反之 7261 防水白 不含仿亚麻 -> 不加前缀，保持 仿亚麻白 不变）
    const itemName = String(item?.outputText || item?.searchText || "").replace(/色/g, "");
    const funcFinish = ["防水", "全遮光", "半遮光"].find((f) => relevantText.includes(f) && itemName.includes(f) && itemName.includes(fabricSpec));
    return normalizeSpecWord(funcFinish ? `${funcFinish}${fabricSpec}` : fabricSpec);
  }

  // 2. 匹配【哑光/亮光】+ 颜色 (如 6010 亮光白, 6025 哑光灰, 6010 哑光奶油)
  const finishMatch = relevantText.match(/(?:【)?(哑光|亚光|亮光|珠光)(?:】)?\s*(奶油|白|灰|黑|银|粉|绿|蓝|黄|米白|淡黄|米黄|金|香槟|紫|红)?(?:色)?/);
  if (finishMatch && finishMatch[2]) {
    const finish = finishMatch[1] === "亚光" ? "哑光" : finishMatch[1];
    return normalizeSpecWord(`${finish}${finishMatch[2]}`);
  }

  // 3. 匹配【全遮光/半遮光/防水】+ 颜色 (如 8000 全遮光灰, 8000 防水淡黄, 8000 防水白, 8863 全遮光米黄)
  const shadeMatch = relevantText.match(/(全遮光|半遮光|防水)\s*(?:ProMax\s*)?(灰|白|米白|黑|深灰|浅灰|淡黄|米黄|黄|蓝|绿|粉|红|紫|咖|奶茶|卡其)?(?:色)?/i);
  if (shadeMatch && shadeMatch[2]) {
    return normalizeSpecWord(`${shadeMatch[1]}${shadeMatch[2]}`);
  }

  // 4. 从匹配物料对象的中文名称提取
  if (item?.searchText) {
    const cleanItemName = item.searchText.replace(/M-\d+/gi, "").trim();
    const itemMatch = cleanItemName.match(/(仿亚麻|细麻|粗麻|高精密|全遮光|半遮光|防水|亚麻|亮光|哑光|珠光)?\s*(月光白|深空灰|米白|白|灰|黑|淡黄|米黄|深灰|浅灰|奶油|素白|褐|浅绿|淡蓝|黄|蓝|绿|粉|红|紫|金|银|香槟|卡其|驼|奶茶|焦糖|胡桃|咖啡)(?:色)?/);
    if (itemMatch) {
      const p1 = itemMatch[1] || "";
      const p2 = itemMatch[2] || "";
      return normalizeSpecWord(`${p1}${p2}`);
    }
  }

  // 5. 基础颜色与工艺组合
  if (parsed.colors && parsed.colors.length > 0) {
    const c = normalizeSpecWord(parsed.colors[0]);
    const finish = parsed.crafts.includes("哑光") || parsed.crafts.includes("亚光")
      ? "哑光"
      : (parsed.crafts.includes("亮光") ? "亮光" : (parsed.crafts.includes("防水") ? "防水" : (parsed.crafts.includes("全遮光") ? "全遮光" : (parsed.crafts.includes("半遮光") ? "半遮光" : ""))));
    return normalizeSpecWord(finish && !c.startsWith(finish) ? `${finish}${c}` : c);
  }

  return "";
}

export function resolveMaterialText(parsed, materials, rules = defaultKnowledgeRules) {
  if (!parsed || !parsed.productCode) return null;
  const rawText = parsed.normalizedText || parsed.rawText || "";

  // 0. 色号直通：原文出现的 5 位色号与物料库精确匹配时直接锁定（如「象牙白-81081」→ 81081 坚美直轨白色）
  const colorCodes = [...new Set(rawText.match(/(?<![\d.])\d{5}(?!\d)/g) || [])];
  for (const code of colorCodes) {
    if (code === parsed.productCode) continue;
    const matched = (materials || []).find((item) => item.status === "confirmed" && item.aliases?.includes(code));
    if (!matched) continue;
    const cleanWord = normalizeSpecWord(String(matched.searchText || "").replace(/^[A-Za-z]*-?\d+\s*/, "").trim()) || code;
    const outputText = `${parsed.productCode} ${cleanWord}`;
    return {
      material: matched,
      variant: { modelCode: code, outputText },
      outputText
    };
  }

  // 1. 如果订单明确为主图款，优先检查主图款映射表
  const isMainPictureMentioned = /主图/.test(rawText);
  if (isMainPictureMentioned && rules?.mainPictureModels?.[parsed.productCode]) {
    const mainPic = rules.mainPictureModels[parsed.productCode];
    if (mainPic.modelCode) {
      const targetCode = mainPic.modelCode;
      const matched = materials.find((item) =>
        item.status === "confirmed" &&
        (item.aliases.includes(targetCode) || item.searchText.includes(targetCode))
      );
      if (matched) {
        return {
          material: matched,
          variant: { modelCode: targetCode, outputText: `${parsed.productCode} ${targetCode}` },
          outputText: `${parsed.productCode} ${targetCode}`
        };
      }
      return {
        material: { searchText: mainPic.fullDescription, aliases: [targetCode], status: "confirmed" },
        variant: { modelCode: targetCode, outputText: `${parsed.productCode} ${targetCode}` },
        outputText: `${parsed.productCode} ${targetCode}`
      };
    }
  }

  // 2. 全局候选面料评分（针对在售 512 物料库）
  const raw = rawText.replace(/色/g, "").toLowerCase();
  const rawCompact = raw.replace(/\s+|\[\[\]【】]/g, "");
  const color = (parsed.colors[0] || "").replace(/色/g, "").toLowerCase();
  const requiredFeatures = ["防水", "半遮光", "全遮光", "亮光", "哑光", "亚光", "仿亚麻"].filter((feature) => raw.includes(feature));

  const candidates = (materials || []).map((item) => {
    if (item.status !== "confirmed" || !/^\d+$/.test(item.aliases?.[0] || "")) return null;
    if (item.aliases.includes(parsed.productCode)) return null;

    if (item.variants && item.variants.length > 0) return null;
    const categoryCodes = new Set(["6010", "6003", "6025", "6045", "8000", "8866", "8815", "8862", "8865", "8816", "8818", "5002", "5001", "5003", "8002", "8801", "8802", "8820"]);
    if (categoryCodes.has(item.aliases?.[0]) || (item.searchText && categoryCodes.has(item.searchText.trim()))) return null;

    const name = String(item.searchText || item.candidateNames?.[0] || "").replace(/色/g, "").toLowerCase();
    const nameCompact = name.replace(/\s+|\[\[\]【】]/g, "");
    if (!name) return null;

    let exactNameMentioned = nameCompact.length >= 3 && rawCompact.includes(nameCompact);
    if (exactNameMentioned) {
      // 粘连词排他：名字若粘连在更长纹理词内部（如“亚麻灰”粘在“仿亚麻灰”里），
      // 且物料库存在包含该更长词的物料，则不算精确命中，交给变体/评分流程处理
      const idx = rawCompact.indexOf(nameCompact);
      const prev = idx > 0 ? rawCompact[idx - 1] : "";
      if (prev && /[\u4e00-\u9fa5a-z0-9]/.test(prev)) {
        const glued = prev + nameCompact;
        const hasLonger = (materials || []).some((other) => other !== item && other.status === "confirmed" &&
          String(other.searchText || "").replace(/色/g, "").toLowerCase().replace(/\s+/g, "").includes(glued));
        if (hasLonger) exactNameMentioned = false;
      }
    }
    if (exactNameMentioned) {
      return { item, score: 500 + nameCompact.length, name };
    }

    if (color && !name.includes(color)) return null;

    if (raw.includes("全遮光") && !raw.includes("半遮光") && name.includes("半遮光")) return null;
    if (raw.includes("半遮光") && !raw.includes("全遮光") && name.includes("全遮光")) return null;
    if (raw.includes("亮光") && !raw.includes("哑光") && !raw.includes("亚光") && (name.includes("哑光") || name.includes("亚光"))) return null;
    if ((raw.includes("哑光") || raw.includes("亚光")) && !raw.includes("亮光") && name.includes("亮光")) return null;

    const matchedFeatures = requiredFeatures.filter((f) => name.includes(f));
    if (requiredFeatures.length > 0 && matchedFeatures.length === 0) return null;

    const conflictingFeatures = ["半遮光", "全遮光", "亮光", "哑光", "亚光", "仿亚麻"].filter((feature) => name.includes(feature) && !raw.includes(feature));
    if (conflictingFeatures.length) return null;

    const score = (color ? 50 : 0) + matchedFeatures.length * 30 - name.length * 0.01;
    return { item, score, name };
  }).filter(Boolean).sort((a, b) => b.score - a.score);

  // 2.1 精确包含面料全名 (score >= 500) 优先命中 (如 Pro高精密深空灰 -> 9602)
  if (candidates.length && candidates[0].score >= 500) {
    const best = candidates[0];
    const modelCode = best.item.aliases[0];
    const spec = extractChineseSpec(rawText, parsed, best.item);
    const cleanWord = normalizeSpecWord(spec || parsed.colors[0]);
    const outputText = `${parsed.productCode} ${cleanWord}`;
    return {
      material: best.item,
      variant: { modelCode, outputText },
      outputText
    };
  }

  // 3. 检查款号自带的 variants 定义 (如 8000, 6010, 6025 等)
  const catItem = (materials || []).find((m) => m.aliases?.includes(parsed.productCode));
  if (catItem?.variants?.length) {
    const v = catItem.variants.find((it) =>
      (!it.finish || parsed.crafts.includes(it.finish)) &&
      (!it.color || parsed.colors.includes(it.color)) &&
      (!it.textMust || raw.includes(String(it.textMust).replace(/色/g, "").toLowerCase()))
    );
    if (v) {
      if (v.outputText && !/\d{3,}/.test(v.outputText)) {
        return {
          material: catItem,
          variant: v,
          outputText: v.outputText
        };
      }
      const spec = extractChineseSpec(rawText, parsed, v);
      const cleanWord = normalizeSpecWord(spec || v.color);
      const outputText = `${parsed.productCode} ${cleanWord}`;
      return {
        material: catItem,
        variant: { ...v, outputText },
        outputText
      };
    }
  }

  // 4. 普通候选面料命中：必须存在识别信号（颜色或特征词），否则 0 分并列等于盲选，交回 null 走双链/人工
  const hasSpecSignal = Boolean(color) || requiredFeatures.length > 0;
  if (hasSpecSignal && candidates.length) {
    const best = candidates[0];
    const modelCode = best.item.aliases[0];
    const spec = extractChineseSpec(rawText, parsed, best.item);
    const cleanWord = normalizeSpecWord(spec || parsed.colors[0]);
    const outputText = cleanWord
      ? `${parsed.productCode} ${cleanWord}`
      : `${parsed.productCode} ${modelCode}`;
    return {
      material: best.item,
      variant: { modelCode, outputText },
      outputText
    };
  }

  // 5. 纯文字兜底直出
  const fallbackSpec = extractChineseSpec(rawText, parsed, null);
  const cleanWord = normalizeSpecWord(fallbackSpec || parsed.colors[0]);
  if (!cleanWord) return null;
  const outputText = `${parsed.productCode} ${cleanWord}`;
  return {
    material: { searchText: outputText, aliases: [cleanWord], status: "confirmed" },
    variant: { modelCode: cleanWord, outputText },
    outputText
  };
}
