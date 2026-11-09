import fs from "node:fs";
import { parseOrderText } from "../src/parser.js";
import { matchSelectionCatalogFromText } from "../src/catalog-match.js";
const records = JSON.parse(fs.readFileSync(new URL("../data/selection-catalog.index.json", import.meta.url), "utf8")).records;
const text = "8201 免打孔 透景 清晰云白;制作宽0.842米 高1.3米 免打孔 右拉珠";
const parsed = parseOrderText(text);
console.log(JSON.stringify({ parsed, match: matchSelectionCatalogFromText({ productCode: parsed.productCode, rawText: text, crafts: parsed.crafts }, records) }, null, 2));
