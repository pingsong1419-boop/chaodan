import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { buildDetailRows, parseAmount, parseOrderText } from "./parser.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "config.json");
if (!fs.existsSync(configPath)) fs.copyFileSync(path.join(root, "config.example.json"), configPath);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const mappings = JSON.parse(fs.readFileSync(path.join(root, "data", "material-map.json"), "utf8"));
const input = readline.createInterface({ input: process.stdin, output: process.stdout });
let context;

async function main() {
  context = await chromium.launchPersistentContext(path.resolve(root, config.userDataDir), { channel: "msedge", headless: config.headless, viewport: null });
  console.log("请在 Edge 中登录并打开聚水潭与报价单页面。");
  await input.question("页面准备好后按 Enter：");
  const erp = context.pages().find((page) => page.url().includes(config.erpUrlPattern));
  const quote = context.pages().find((page) => page.url().includes(config.quoteUrlPattern));
  if (!erp || !quote) throw new Error("未同时找到聚水潭和报价单页面");
  const selected = erp.locator(config.selectors.erpSelectedRow).last();
  if (!(await selected.count())) throw new Error("请先在聚水潭中选中一笔订单");
  const text = (await selected.innerText()).trim();
  const parsed = parseOrderText(text);
  const orderId = text.match(/\b\d{6,}\b/)?.[0] ?? null;
  const amount = parseAmount(text);
  const material = mappings.materials.find((item) => item.status === "confirmed" && item.aliases.includes(parsed.productCode));
  console.log(JSON.stringify({ orderId, amount, parsed, material, rows: buildDetailRows(parsed) }, null, 2));
  const blockers = [...parsed.issues, ...(!orderId ? ["未识别订单号"] : []), ...(!amount ? ["未识别成交金额"] : []), ...(!material ? ["物料尚未确认"] : [])];
  if (blockers.length) {
    console.log(`已暂停：${blockers.join("；")}`);
  } else {
    await quote.locator(config.selectors.quoteContact).first().fill(orderId);
    await quote.locator(config.selectors.quoteAmount).first().fill(amount);
    console.log("报价单主表已填写；dryRun 模式不会点击保存，请人工核对。");
  }
  await input.question("按 Enter 关闭：");
  await context.close();
  await input.close();
}

main().catch(async (error) => {
  console.error(`自动化停止：${error.message}`);
  if (context) await context.close().catch(() => {});
  input.close();
  process.exitCode = 1;
});
