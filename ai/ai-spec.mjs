import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const configPath = path.join(here, "config.json");
const materialPath = path.join(root, "data", "material-map.json");

export function loadConfig() {
  if (!fs.existsSync(configPath)) {
    throw new Error("还没有配置。请把 ai/config.example.json 复制成 ai/config.json，并填入 apiKey。");
  }
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const active = cfg.providers?.[cfg.provider];
  if (!active) throw new Error(`config.json 里的 provider「${cfg.provider}」不存在`);
  if (!active.apiKey) {
    throw new Error(`provider「${cfg.provider}」的 apiKey 还是空的。注册地址：${active.signupUrl || "见 config.example.json"}`);
  }
  return { ...cfg, active };
}

export function loadMaterials() {
  try {
    return JSON.parse(fs.readFileSync(materialPath, "utf8")).materials || [];
  } catch {
    return [];
  }
}

// 脱敏：只保留款号后的规格片段，抹掉订单号、手机号、姓名、详细地址
export function extractSpecFragment(orderText, productCode = "") {
  let text = String(orderText || "");
  text = text.replace(/\d{7,}/g, " ");
  text = text.replace(/1[3-9]\d{9}/g, " ");
  // 地址清洗按行执行：含款号的规格行绝不动——「加急7号发顺丰」这类备注里的「号」
  // 会被地址正则当作门牌号而整行吞掉颜色工艺词（2600836 实盘事故）；「号楼?」已收窄为「号楼」
  const provinceRe = /(?:浙江|江苏|广东|山东|河南|河北|四川|湖北|湖南|福建|安徽|江西|陕西|山西|辽宁|吉林|黑龙江|云南|贵州|广西|甘肃|内蒙古|新疆|宁夏|青海|西藏|海南|北京|上海|天津|重庆)省?[^。；;\n]{0,50}/g;
  const addrRe = /[^。；;\n]{0,20}(?:省|市|区|县|镇|街道|路|号楼|栋|单元|室)[^。；;\n]{0,40}/g;
  const lines = text.split("\n");
  if (lines.length > 1 && productCode) {
    text = lines
      .map((line) => (line.includes(productCode) ? line : line.replace(provinceRe, " ").replace(addrRe, " ")))
      .join("\n");
  } else {
    text = text.replace(provinceRe, " ").replace(addrRe, " ");
  }
  text = text.replace(/\*+/g, " ");
  text = text.replace(/(?:旗舰店|专卖店|专营店|天猫|淘宝|京东|拼多多)/g, " ");
  text = text.replace(/(?:卖家备注|买家备注|内部订单号|已付款待审核|发货中|待付款)/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  // 定位款号：BY 开头不限两位数字；4 位数字需排除年份（202x/203x），否则会把日期误当款号截掉规格段
  const codeIndex = text.search(/BY\d{2,}|\b00[1-4]\b|(?<!\d)(?!(?:202\d|203\d)(?:[-/年]|\b))[1-9]\d{3}(?!\d)/);
  if (codeIndex > 40) text = text.slice(codeIndex - 10);
  return text.slice(0, 400);
}

// 词表：仅用于「事后校验 / 统计」，不再约束模型输出
export function buildSpecVocab(materials) {
  const vocab = new Set();
  for (const item of materials || []) {
    if (item.status !== "confirmed") continue;
    const variants = item.variants || [];
    for (const v of variants) {
      const spec = String(v.outputText || "").replace(/^\S+[\s,，]/, "").trim();
      if (spec) vocab.add(spec);
      if (v.color) vocab.add(String(v.color).replace(/色$/, ""));
    }
    if (!variants.length && item.searchText) {
      const spec = String(item.searchText).replace(/^[A-Za-z]*-\d+\s*/, "").trim();
      if (spec && spec.length <= 12) vocab.add(spec);
    }
  }
  return [...vocab].filter((s) => s.length >= 1 && s.length <= 14).sort((a, b) => b.length - a.length);
}

// 安装方式不属于颜色/工艺，模型若仍带出，这里兜底剔除
const MOUNT_RE = /(?:免打孔|免钉|打孔款|打孔|胀紧|卡帘|帘罩款|内装|外装|卡槽)/g;

export function sanitizeWord(raw) {
  const before = String(raw || "").trim();
  let s = before;
  s = s.replace(MOUNT_RE, "");
  s = s.replace(/[\d.]+/g, "");
  s = s.replace(/[【】\[\]（）()「」]/g, "");
  s = s.replace(/[+丨|、,，/]/g, "");
  s = s.replace(/\s+/g, "");
  return { value: s, changed: s !== before };
}

function stripFence(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

function buildBody(model, messages, cfg) {
  const body = { model, messages };
  // 部分模型（如 Kimi K3）固定 temperature / top_p，传了会直接报错
  if (!cfg.active.omitTemperature) body.temperature = cfg.temperature ?? 0;
  if (cfg.jsonMode !== false) body.response_format = { type: "json_object" };
  return body;
}

export async function callLLM(messages, cfg) {
  const { baseUrl, model, apiKey } = cfg.active;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || 20000);
  try {
    const res = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildBody(model, messages, cfg)),
      signal: controller.signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`模型接口返回 HTTP ${res.status}：${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("模型没有返回内容");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM_PROMPT = `你是窗帘订单的规格信息抽取助手。你唯一要做的事：从订单片段里分辨出【哪几个字是颜色】、【哪几个字是工艺面料】，并原样抄出来。

严格规则：
1. color：只填颜色本身。必须原样照抄订单里出现的字，不要改写、不要补字、不要删字、不要自己造词。订单写「米白」就填「米白」，写「哑光奶油」就填「奶油」。
2. finishes：面料或工艺修饰词。范围包括：防水、全遮光、半遮光、高遮光、六防全遮、亮光、哑光、亚光、高精密、加厚、珠光、拉丝、缎纹、立体肌理、Pro。按订单原文顺序列出，最多 3 个。
3. 安装方式一律忽略，绝对不要写进 color 或 finishes：免钉、免打孔、打孔、打孔款、胀紧、卡帘、帘罩款、内装、外装、卡槽。
4. 款号（6010、8000、8866、6025 等）、尺寸（宽/高/米/厘米）、左右拉、数量、备注、地址，都不要写进 color 或 finishes。
5. 确实找不到颜色时，color 填空字符串，confidence 压到 0.3 以下。
6. evidence：从订单片段里原样截取一小段，能佐证 color 与 finishes 的取值，不超过 30 字。
7. reason：不超过 20 个汉字说明依据。
8. 麻/纹理词归属（重要）：亚麻、细麻、仿亚麻、仿麻、仿粗麻、绒 这类纹理词如果紧跟颜色字（白/灰/黄/蓝/绿/米/咖/褐/粉等），它们是颜色词的一部分，必须整体填入 color，绝对不要拆进 finishes。例如「仿亚麻灰色」的 color 是「仿亚麻灰」，「细麻米白」的 color 是「细麻米白」，「亚麻褐色」的 color 是「亚麻褐」。

示例：
订单片段「6010 免钉【亮光】米白 制作宽0.62米 高1.3米」
{"color":"米白","finishes":["亮光"],"evidence":"免钉【亮光】米白","confidence":0.95,"reason":"亮光是工艺，米白是颜色，免钉是安装方式"}
订单片段「8000 打孔款 Pro高精密 月光白 制作宽1.0米」
{"color":"月光白","finishes":["Pro","高精密"],"evidence":"Pro高精密 月光白","confidence":0.95,"reason":"打孔款是安装方式已忽略"}
订单片段「8866 胀紧免打孔帘罩款 全遮光+防水丨淡黄」
{"color":"淡黄","finishes":["全遮光","防水"],"evidence":"全遮光+防水丨淡黄","confidence":0.9,"reason":"胀紧免打孔帘罩款均为安装方式"}
订单片段「8000 打孔款 仿亚麻白色[【防水】] 制作宽0.824米」
{"color":"仿亚麻白","finishes":["防水"],"evidence":"仿亚麻白色[【防水】]","confidence":0.9,"reason":"仿亚麻是纹理词并入颜色，防水是工艺"}
订单片段「8000 免打孔 仿亚麻灰色[【防水】] 制作宽0.495米 高1.42米」
{"color":"仿亚麻灰","finishes":["防水"],"evidence":"仿亚麻灰色[【防水】]","confidence":0.9,"reason":"仿亚麻灰是完整颜色词，不可拆成仿亚麻+灰"}
订单片段「8815 免钉 细麻米白 制作宽1.2米 高1.5米」
{"color":"细麻米白","finishes":[],"evidence":"细麻米白","confidence":0.9,"reason":"细麻是纹理词，细麻米白为完整颜色词"}

只输出 JSON，不要任何其他文字。`;

export async function extractSpec({ fragment, productCode, cfg }) {
  const user = `款号：${productCode}\n订单片段：${fragment}`;
  const content = await callLLM(
    [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: user }],
    cfg
  );
  const parsed = JSON.parse(stripFence(content));

  const colorRaw = sanitizeWord(parsed.color);
  const finishList = (Array.isArray(parsed.finishes) ? parsed.finishes : [])
    .map((f) => sanitizeWord(f))
    .filter((f) => f.value)
    .slice(0, 3);

  const sanitized = colorRaw.changed || finishList.some((f) => f.changed);
  const color = colorRaw.value;
  const finishes = finishList.map((f) => f.value);

  return {
    color,
    finishes,
    evidence: String(parsed.evidence || "").slice(0, 60),
    confidence: Number(parsed.confidence ?? 0),
    reason: String(parsed.reason || ""),
    searchText: [productCode, [...finishes, color].filter(Boolean).join("")].filter(Boolean).join(" "),
    sanitized,
    inputChars: SYSTEM_PROMPT.length + user.length,
    raw: content
  };
}
