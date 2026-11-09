import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { matchSelectionCatalog, matchSelectionCatalogFromText } from "../src/catalog-match.js";

const catalog = JSON.parse(fs.readFileSync(new URL("../data/selection-catalog.index.json", import.meta.url), "utf8")).records;

test("8000免打孔Pro高精密深空灰唯一命中系统目录", () => {
  const result = matchSelectionCatalog({ productCode: "8000", color: "深空灰", finishes: ["Pro", "高精密", "防水"], crafts: ["免打孔", "防水"] }, catalog);
  assert.equal(result.status, "unique");
  assert.equal(result.match.id, "NE0002381");
  assert.match(result.match.color, /9602.*高精密深空灰/);
});

test("缺少颜色时不猜目录物料", () => {
  assert.equal(matchSelectionCatalog({ productCode: "8000", color: "" }, catalog).status, "none");
});

test("2630561：仿亚麻白兼容目录历史命名防亚麻白并唯一命中", () => {
  const result = matchSelectionCatalog({ productCode: "8000", color: "仿亚麻白", finishes: ["防水"], crafts: ["免打孔", "防水"] }, catalog);
  assert.equal(result.status, "unique");
  assert.equal(result.match.id, "NE0001203");
  assert.match(result.match.color, /9015防水防亚麻白/);
});

test("纯本地目录反查：2630561 不调用 AI 也能唯一命中 9015", () => {
  const result = matchSelectionCatalogFromText({ productCode: "8000", rawText: "8000 免打孔 仿亚麻白色【防水】制作宽1.36米 高1.36米", crafts: ["免打孔", "防水"] }, catalog);
  assert.equal(result.status, "unique");
  assert.equal(result.match.id, "NE0001203");
  assert.equal(result.extracted.color, "仿亚麻白");
});

test("纯本地目录反查：高精密深空灰唯一命中 9602", () => {
  const result = matchSelectionCatalogFromText({ productCode: "8000", rawText: "8000 免打孔 Pro高精密 深空灰【防水】制作宽0.755米 高1.53米", crafts: ["免打孔", "防水"] }, catalog);
  assert.equal(result.status, "unique");
  assert.equal(result.match.id, "NE0002381");
  assert.equal(result.extracted.color, "深空灰");
});

test("纯本地目录反查：6025免钉哑光白唯一命中免打孔2911", () => {
  const result = matchSelectionCatalogFromText({ productCode: "6025", rawText: "送2个垫片 6025 免钉【哑光】白色 制作宽0.545米 高1.2米", crafts: ["免打孔", "哑光"] }, catalog);
  assert.equal(result.status, "unique");
  assert.equal(result.match.id, "NE0001393");
  assert.equal(result.extracted.color, "白");
});

test("纯本地目录反查：6805 5cm梯带琥珀棕唯一命中0078梯带", () => {
  const result = matchSelectionCatalogFromText({ productCode: "6805", rawText: "6805 5cm橡木/梯带 琥珀棕 制作宽1.4米 制作高1.8米", crafts: [] }, catalog);
  assert.equal(result.status, "unique");
  assert.equal(result.match.id, "NE0000360");
  assert.equal(result.extracted.color, "琥珀棕");
});

test("纯本地目录反查：8863防水加厚全遮光白唯一命中7261", () => {
  const result = matchSelectionCatalogFromText({ productCode: "8863", rawText: "8863 免钉【防水加厚】全遮光白色 制作宽1.145米 高1.385米", crafts: ["免打孔", "防水", "全遮光"] }, catalog);
  assert.equal(result.status, "unique");
  assert.equal(result.match.id, "NE0000745");
  assert.equal(result.extracted.color, "白");
});

test("纯本地目录反查：8863加厚全遮光白未要求防水时唯一命中8261", () => {
  const result = matchSelectionCatalogFromText({ productCode: "8863", rawText: "8863 免钉【加厚】全遮光白色 制作宽0.8米 高1.5米", crafts: ["免打孔", "全遮光"] }, catalog);
  assert.equal(result.status, "unique");
  assert.equal(result.match.id, "NE0000738");
  assert.match(result.match.color, /M-8261/);
});

test("2633909：6010免钉磨砂珍珠白唯一命中2731", () => {
  const rawText = "6010 免钉【磨砂】珍珠白 A:制作宽1.94米 高1.73米 B:制作宽1.73米 高1.73米";
  const result = matchSelectionCatalogFromText({ productCode: "6010", rawText, crafts: ["免打孔"] }, catalog);
  assert.equal(result.status, "unique");
  assert.equal(result.match.id, "NE0002030");
  assert.match(result.match.color, /M-2731/);
});

test("纯本地目录反查：8000 ProMax全遮光白唯一命中9861", () => {
  const result = matchSelectionCatalogFromText({ productCode: "8000", rawText: "8000 免打孔 ProMax全遮光 白色【防水】制作宽0.66米 高1.7米", crafts: ["免打孔", "防水", "全遮光"] }, catalog);
  assert.equal(result.status, "unique");
  assert.equal(result.match.id, "NE0002382");
  assert.equal(result.extracted.color, "白");
});

test("5033防水全遮光薄荷按权威裁决固定命中NE0002873", () => {
  const result = matchSelectionCatalogFromText({
    productCode: "5033",
    rawText: "5033 防水+全遮光 薄荷 制作宽0.723米 高1.4米",
    crafts: ["防水", "全遮光"]
  }, catalog);
  assert.equal(result.status, "unique");
  assert.equal(result.match.id, "NE0002873");
  assert.match(result.match.color, /M-12223/);
});
