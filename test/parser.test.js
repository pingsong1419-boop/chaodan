import test from "node:test";
import assert from "node:assert/strict";
import { buildDetailRows, detectDoNotCopyInstruction, parseAmount, parseOrderText, resolveMaterialText } from "../src/parser.js";

test("保留完整成交金额", () => {
  assert.equal(parseAmount("成交金额 367.32"), "367.32");
  assert.equal(parseAmount("274.64元"), "274.64");
});

test("人工停单备注：暂不抄及同义表达必须拦截", () => {
  for (const text of ["暂不抄 确认尺寸", "暂时不抄", "先不抄单", "不要抄", "勿抄", "禁止抄单", "暂停抄", "暂不录入", "等通知制作", "等客户通知再做", "通知后制作"]) {
    assert.equal(detectDoNotCopyInstruction(text), true, text);
  }
  assert.equal(detectDoNotCopyInstruction("确认尺寸后正常抄单"), false);
});

test("电动产品必须硬拦截，不允许抄单", () => {
  const parsed = parseOrderText("8000 电动卷帘 全遮光白色 制作宽1.2米 高1.5米");
  assert.ok(parsed.issues.includes("电动产品暂不处理，不能抄单"));
});

test("解析尺寸、型号、工艺和左右拉珠", () => {
  const result = parseOrderText("8000 打孔款 Pro高档 防水 制作宽1.025米 高1.3米 数量2个 一个左一个右拉珠");
  assert.equal(result.productCode, "8000");
  assert.equal(result.width, 1.025);
  assert.equal(result.height, 1.3);
  assert.equal(result.quantity, 2);
  assert.deepEqual(result.crafts, ["打孔", "防水"]);
  assert.deepEqual(result.sides, ["左拉珠", "右拉珠"]);
  assert.equal(buildDetailRows(result).length, 2);
});

test("复杂窗型进入人工复核", () => {
  const result = parseOrderText("6010 白色 宽0.8米 高1.2米 U型 数量1个");
  assert.ok(result.issues.some((issue) => issue.includes("复杂窗型")));
});

test("解析6045免钉哑光奶油色", () => {
  const result = parseOrderText("6045 免钉/哑光 奶油色 制作宽0.65米 高1.43米");
  assert.equal(result.productCode, "6045");
  assert.equal(result.width, 0.65);
  assert.equal(result.height, 1.43);
  assert.deepEqual(result.colors, ["奶油色"]);
  assert.deepEqual(result.crafts, ["免打孔", "哑光"]);
  assert.deepEqual(result.issues, []);
});

test("订单号末四位不能识别成商品代号", () => {
  const result = parseOrderText("2595046 6010 免钉 亮光 白色 制作宽0.43米 高1.03米");
  assert.equal(result.productCode, "6010");
});

test("从订单行中读取已付金额而不是行号", () => {
  const row = "3 2595046 6010 免钉 亮光 白色 制作宽0.43米 高1.03米 天猫美尔耐旗舰店 78.12 已付款待审核 1";
  assert.equal(parseAmount(row), "78.12");
});

test("订单行不完整时不把行号猜成金额", () => {
  assert.equal(parseAmount("9 2595046 6010 白色 制作宽0.43米 高1.03米"), null);
});

test("6010亮光白色格式统一为货号+颜色中文6010 亮光白", () => {
  const parsed = parseOrderText("6010 免钉【亮光】白色 制作宽0.43米 高1.03米");
  const materials = [{
    aliases: ["6010"], status: "confirmed", searchText: "6010",
    variants: [{ finish: "亮光", color: "白色", modelCode: "2701" }]
  }];
  assert.deepEqual(parsed.crafts, ["免打孔", "亮光"]);
  assert.equal(resolveMaterialText(parsed, materials).outputText, "6010 亮光白");
});

test("剔除结构化字段后保留剩余原文作为备注", () => {
  const parsed = parseOrderText("8863 免钉 半遮光白色 制作宽1.435米 高2.335米 只要帘布不要轨道 宽度尺寸正常扣减@售后送");
  assert.equal(parsed.remark, "只要帘布不要轨道 宽度尺寸正常扣减@售后送");
  assert.equal(buildDetailRows(parsed)[0].remark, "只要帘布");
});

test("没有额外文字时备注为空", () => {
  const parsed = parseOrderText("6010 免钉【亮光】白色 制作宽0.43米 高1.03米");
  assert.equal(parsed.remark, "");
});

test("8000防水淡黄从已确认型号表组合为8000空格7265", () => {
  const parsed = parseOrderText("8000 免打孔 淡黄[【防水】]制作宽0.77米 高1.2米");
  const materials = [{ aliases: ["7265"], searchText: "防水淡黄色", candidateNames: ["防水淡黄色"], status: "confirmed" }];
  assert.deepEqual(parsed.colors, ["淡黄色"]);
  assert.equal(resolveMaterialText(parsed, materials).outputText, "8000 防水淡黄");
});

test("同一订单两组尺寸生成两条明细且保留共同备注", () => {
  const parsed = parseOrderText("5065 单玻磁控蜂巢 白色边框 白色帘布 全遮光 制作宽 0.605米 高1.209米 制作宽 0.487米 高 1.088米 包安装");
  const rows = buildDetailRows(parsed);
  assert.equal(parsed.quantity, 2);
  assert.deepEqual(parsed.dimensionPairs, [{ width: 0.605, height: 1.209 }, { width: 0.487, height: 1.088 }]);
  assert.deepEqual(rows.map((row) => [row.width, row.height, row.remark]), [[0.605, 1.209, ""], [0.487, 1.088, ""]]);
});

test("报价单备注规则：普通产品默认右拉不备注，左拉必须备注", () => {
  const right = buildDetailRows(parseOrderText("8000 防水白色 制作宽0.8米 高1.5米 右拉珠"));
  const left = buildDetailRows(parseOrderText("8000 防水白色 制作宽0.8米 高1.5米 左拉珠"));
  assert.equal(right[0].remark, "");
  assert.equal(left[0].remark, "左拉");
});

test("报价单备注规则：5002默认双拉不备注，左右单拉必须备注", () => {
  const both = buildDetailRows(parseOrderText("5002 制作宽0.8米 高1.5米 双拉珠"));
  const left = buildDetailRows(parseOrderText("5002 制作宽0.8米 高1.5米 左单拉"));
  const right = buildDetailRows(parseOrderText("5002 制作宽0.8米 高1.5米 右单拉"));
  assert.equal(both[0].remark, "");
  assert.equal(left[0].remark, "左单拉");
  assert.equal(right[0].remark, "右单拉");
});

test("报价单备注规则：两头装必须写入，并与左拉组合", () => {
  const left = buildDetailRows(parseOrderText("8815 帘罩款 细麻米白色 制作宽1.735米 高1.67米 左拉 两头装"));
  const right = buildDetailRows(parseOrderText("8815 帘罩款 细麻米白色 制作宽1.735米 高1.67米 右拉 两头装"));
  assert.equal(left[0].remark, "左拉 两头装");
  assert.equal(right[0].remark, "两头装");
});

test("报价单备注规则：不要LOGO必须写入并与其他要求组合", () => {
  const combined = buildDetailRows(parseOrderText("8815 制作宽1.2米 高1.5米 左拉 两头装 不要logo"));
  const onlyLogo = buildDetailRows(parseOrderText("8815 制作宽1.2米 高1.5米 右拉 无LOGO"));
  assert.equal(combined[0].remark, "左拉 两头装 不要LOGO");
  assert.equal(onlyLogo[0].remark, "不要LOGO");
});

test("报价单备注规则：帘布、加急交期、收起尺寸、配色和同一面必须保留", () => {
  const parsed = parseOrderText("8815 制作宽1.2米 高1.5米 左拉 只要帘布不要轨道 加急10月29日之前发货 收起来厚度3厘米 收起来高度5.5cm 拉珠和帘布配色 同一面");
  const row = buildDetailRows(parsed)[0];
  assert.equal(row.remark, "左拉 只要帘布 加急 10月29日之前发货 收起来厚度3厘米 收起来高度5.5cm 拉珠和帘布配色 同一面");
});

test("报价单备注规则：点号日期加‘号前发出’必须完整保留", () => {
  const parsed = parseOrderText("加急10.27号前发出 8818 帘罩款 全遮光浅灰 制作宽1.48米 高1.5米 数量5 右拉");
  const row = buildDetailRows(parsed)[0];
  assert.equal(row.remark, "加急 10.27号前发出");
});

test("2633909：A/B两组完整尺寸生成两条独立报价明细", () => {
  const parsed = parseOrderText("6010 免钉【磨砂】珍珠白 A:制作宽1.94米 高1.73米 B:制作宽1.73米 高1.73米");
  const rows = buildDetailRows(parsed);
  assert.equal(parsed.quantity, 2);
  assert.deepEqual(rows.map((row) => [row.width, row.height, row.quantity]), [
    [1.94, 1.73, 1],
    [1.73, 1.73, 1]
  ]);
});

test("2634014：同规格数量2生成一条明细并填写件数2", () => {
  const parsed = parseOrderText("5003 免打孔 全遮光【防水】星沙白 制作宽0.487米 高1.55米 数量2");
  const rows = buildDetailRows(parsed);
  assert.equal(parsed.quantity, 2);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].width, rows[0].height, rows[0].quantity, rows[0].remark], [0.487, 1.55, 2, ""]);
});

test("2629926：两组尺寸各数量2左右拉，必须生成四件独立明细", () => {
  const parsed = parseOrderText("8815 帘罩款 细麻灰色 制作宽1.535米 高1.88米 数量2 左右拉 制作宽1.63米 高1.88米 数量2 左右拉");
  const rows = buildDetailRows(parsed);
  assert.equal(parsed.quantity, 4);
  assert.deepEqual(parsed.detailGroups, [
    { width: 1.535, height: 1.88, quantity: 2, sides: ["左拉珠", "右拉珠"] },
    { width: 1.63, height: 1.88, quantity: 2, sides: ["左拉珠", "右拉珠"] }
  ]);
  assert.deepEqual(rows.map((row) => [row.width, row.height, row.quantity, row.remark]), [
    [1.535, 1.88, 1, "左拉"],
    [1.535, 1.88, 1, ""],
    [1.63, 1.88, 1, "左拉"],
    [1.63, 1.88, 1, ""]
  ]);
});

test("2634010：同一平面数量2左右拉，拆成左右各一件且两行都备注同一面", () => {
  const parsed = parseOrderText("6010 打孔【哑光】白色 制作宽1.685米 高2.235米 数量2 同一平面 左右拉");
  const rows = buildDetailRows(parsed);
  assert.equal(parsed.quantity, 2);
  assert.deepEqual(rows.map((row) => [row.width, row.height, row.quantity, row.side, row.remark]), [
    [1.685, 2.235, 1, "左拉珠", "左拉 同一面"],
    [1.685, 2.235, 1, "右拉珠", "同一面"]
  ]);
});

test("订单原文完整出现面料名称时优先组合对应色号", () => {
  const parsed = parseOrderText("8815 免钉帘罩款 细麻米白色 定制[【全遮光】] 制作宽1.45米 高1.45米");
  const materials = [
    { aliases: ["8281"], searchText: "细麻米白色", status: "confirmed" },
    { aliases: ["8261"], searchText: "全遮光白色", status: "confirmed" }
  ];
  assert.equal(resolveMaterialText(parsed, materials).outputText, "8815 细麻米白");
});

test("8000防水白色使用726x专属系列而不是同名色号", () => {
  const parsed = parseOrderText("8000-免打孔防水白色 制作宽0.46米 高1.2米");
  const materials = [{
    aliases: ["8000"], status: "confirmed",
    variants: [
      { finish: "防水", color: "白色", modelCode: "7261" },
      { finish: "防水", color: "淡黄色", modelCode: "7265" }
    ]
  }];
  assert.equal(resolveMaterialText(parsed, materials).outputText, "8000 防水白");
});

test("等待订单合并或异常状态必须暂停", () => {
  const parsed = parseOrderText("8604 打孔 半遮光 制作宽1.895米 高1.635米 异常 等待订单合并");
  assert.ok(parsed.issues.includes("订单等待合并，不能抄单"));
});

test("收货地址中的地名不能识别成颜色", () => {
  const parsed = parseOrderText("8000 防水 白色 制作宽1.2米 高1.5米 浙江省台州市黄岩区东城街道");
  assert.deepEqual(parsed.colors, ["白色"]);
});

test("单独的黄色仍能识别", () => {
  const parsed = parseOrderText("8000 防水 黄色 制作宽1.2米 高1.5米");
  assert.deepEqual(parsed.colors, ["黄色"]);
});

test("色号直通：原文 5 位色号直接锁定物料库对应物料", () => {
  const parsed = parseOrderText("BY3009 坚美直轨 象牙白-81081 制作宽3米 侧装单轨 断开分二");
  const materials = [{ aliases: ["81081"], searchText: "坚美直轨白色", status: "confirmed" }];
  const resolved = resolveMaterialText(parsed, materials);
  assert.equal(resolved.variant.modelCode, "81081");
  assert.equal(resolved.outputText, "3009 坚美直轨白");
});

test("象牙白识别为白色系", () => {
  const parsed = parseOrderText("BY3009 坚美直轨 象牙白-81081 制作宽3米 侧装单轨");
  assert.deepEqual(parsed.colors, ["白色"]);
});

test("无任何颜色工艺信号时规则链不盲选，返回 null 交双链/人工", () => {
  const parsed = parseOrderText("3009 制作宽3米 侧装单轨");
  const materials = [{ aliases: ["8003"], searchText: "棕色", candidateNames: ["棕色"], status: "confirmed" }];
  assert.equal(resolveMaterialText(parsed, materials), null);
});

test("脱敏手机号尾号不能识别成商品代号", () => {
  const parsed = parseOrderText("2601024 线上预售 天猫美尔耐旗舰店 209.7 浙江省杭州市上城区小营街道(阮**)(********9678)");
  assert.equal(parsed.productCode, null);
});

test("脱敏号码前的真实款号不受影响", () => {
  const parsed = parseOrderText("6010 免钉【亮光】白色 制作宽0.43米 高1.03米 (********9678)");
  assert.equal(parsed.productCode, "6010");
});

test("已付金额整数部分不能冒充商品款号", () => {
  const parsed = parseOrderText("2630529 天猫美尔耐旗舰店 已付金额: 1676.11 已付款待审核");
  assert.equal(parsed.productCode, null);
});

test("商品售价不能冒充商品款号", () => {
  const parsed = parseOrderText("2630532 线上预售 商品名称 ￥1299 数量:1");
  assert.equal(parsed.productCode, null);
});

test("促销门槛金额不能冒充商品款号", () => {
  const parsed = parseOrderText("2630532 磁控测量 美尔耐窗帘五折测量特权 【满1299可全额抵扣】或补邮费 ￥50");
  assert.equal(parsed.productCode, null);
});

test("赠送垫片数量不能冒充窗帘件数", () => {
  const parsed = parseOrderText("送2个垫片 6025 免钉【哑光】白色 制作宽0.545米 高1.2米");
  assert.equal(parsed.quantity, 1);
});

test("2633159：送打孔支架2个不能冒充产品2件或打孔工艺", () => {
  const parsed = parseOrderText("送打孔支架2个 6025 免钉【亮光】白色 制作宽0.87米 高0.96米 左拉");
  const rows = buildDetailRows(parsed);
  assert.equal(parsed.productCode, "6025");
  assert.equal(parsed.quantity, 1);
  assert.deepEqual(parsed.crafts, ["免打孔", "亮光"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].remark, "左拉");
});
