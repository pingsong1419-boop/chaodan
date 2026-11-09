import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = path.join(root, "data");
const rawPath = path.join(dataDir, "selection-catalog.raw.json");
const indexPath = path.join(dataDir, "selection-catalog.index.json");
const reportPath = path.join(dataDir, "selection-catalog.summary.json");

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((item) => item.url().includes("47.121.28.8") && item.url().includes("/Edit/"));
  if (!page) throw new Error("未找到已登录的报价编辑页面，请保持选品弹窗打开");

  const pageSize = 200;
  const rows = [];
  let expected = 0;
  let pageNumber = 1;
  let totalPages = 1;
  while (pageNumber <= totalPages) {
    let result = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 3 && !result; attempt += 1) {
      try {
        result = await page.evaluate(async ({ pageNumber, pageSize }) => {
          const body = new URLSearchParams({
            类别: "",
            往来单位编号: "",
            品号关键字: "",
            _search: "false",
            rows: String(pageSize),
            page: String(pageNumber),
            sidx: "项目编号",
            sord: "asc"
          });
          const response = await fetch("/%E9%A1%B9%E7%9B%AE%E7%BC%96%E5%8F%B7%E8%A1%A8/List", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
            body
          });
          if (!response.ok) throw new Error(`选品接口返回 HTTP ${response.status}`);
          return response.json();
        }, { pageNumber, pageSize });
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
      }
    }
    if (!result) throw new Error(`选品目录第 ${pageNumber} 页连续读取失败：${lastError?.message || "未知错误"}`);
    const currentRows = Array.isArray(result.rows) ? result.rows : [];
    if (pageNumber === 1) {
      expected = Number(result.records || 0);
      totalPages = Number(result.total || Math.ceil(expected / pageSize) || 1);
    }
    if (!currentRows.length && rows.length < expected) throw new Error(`选品目录第 ${pageNumber} 页为空，下载未完成`);
    rows.push(...currentRows);
    console.log(`[目录同步] 第 ${pageNumber}/${totalPages} 页，累计 ${rows.length}/${expected || "?"} 条`);
    pageNumber += 1;
  }

  if (!rows.length) throw new Error("选品接口未返回物料记录");
  if (expected && rows.length !== expected) {
    throw new Error(`物料数量不完整：接口声明 ${expected} 条，实际取得 ${rows.length} 条`);
  }

  const ids = rows.map((row) => String(row.项目编号 || "").trim()).filter(Boolean);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) throw new Error(`发现重复项目编号：${ids.length - uniqueIds.size} 条`);

  const syncedAt = new Date().toISOString();
  const normalized = rows.map((row) => ({
    id: String(row.项目编号 || "").trim(),
    categoryCode: String(row.类别 || "").trim(),
    projectName: String(row.项目名称 || "").trim(),
    specification: String(row.规格 || "").trim(),
    specification2: String(row.规格2 || "").trim(),
    color: String(row.颜色 || "").trim(),
    unit: String(row.单位 || "").trim(),
    projectCategory: String(row.项目类别 || "").trim(),
    attribute: String(row.属性 || "").trim(),
    bomCode: String(row.BOM编号 || "").trim(),
    bomName: String(row.BOM名称 || "").trim(),
    warehouse: String(row.默认仓库 || "").trim(),
    departmentCode: String(row.往来单位编号 || "").trim(),
    departmentName: String(row.往来单位名称 || "").trim(),
    purchasePrice: Number(row.基准进价 || 0),
    salePrice: Number(row.基准销价 || 0),
    balance: Number(row.项目数字2 || 0),
    isForSale: Boolean(row.是否销售),
    isDisabled: Boolean(row.是否失效),
    productionLabel: String(row.生产标签 || "").trim(),
    textFields: [1, 2, 3, 4, 5, 6, 7].map((n) => String(row[`项目文本${n}`] || "").trim()),
    keyword: String(row.品号关键字 || "").trim(),
    searchText: [row.项目编号, row.项目名称, row.规格, row.规格2, row.颜色, row.项目类别,
      row.BOM编号, row.BOM名称, row.属性, row.品号关键字,
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => row[`项目文本${n}`])]
      .filter(Boolean).join(" ").replace(/\s+/g, " ").trim()
  }));

  const groupCounts = (key) => Object.fromEntries([...rows.reduce((map, row) => {
    const value = String(row[key] || "未分类").trim() || "未分类";
    map.set(value, (map.get(value) || 0) + 1);
    return map;
  }, new Map())].sort((a, b) => b[1] - a[1]));

  const summary = {
    syncedAt,
    source: "/项目编号表/List",
    declaredRecords: expected,
    downloadedRecords: rows.length,
    uniqueProjectIds: uniqueIds.size,
    disabledRecords: rows.filter((row) => row.是否失效).length,
    saleEnabledRecords: rows.filter((row) => row.是否销售).length,
    byProjectName: groupCounts("项目名称"),
    byProjectCategory: groupCounts("项目类别"),
    byUnit: groupCounts("单位")
  };

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(rawPath, `${JSON.stringify({ syncedAt, records: rows }, null, 2)}\n`, "utf8");
  fs.writeFileSync(indexPath, `${JSON.stringify({ syncedAt, records: normalized }, null, 2)}\n`, "utf8");
  fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ rawPath, indexPath, reportPath, ...summary }, null, 2));
} finally {
  await browser.close();
}
