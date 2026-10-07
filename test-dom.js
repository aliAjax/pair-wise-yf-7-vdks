// 使用 jsdom 模拟浏览器环境，加载 app.js 检查运行时错误与核心流程
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const reconCode = fs.readFileSync(path.join(__dirname, "reconciliation.js"), "utf8");
const appCode = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");

const errors = [];
const warnings = [];

const dom = new JSDOM(html, {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "http://localhost/"
});

dom.window.console.error = (...args) => errors.push(args.join(" "));
dom.window.console.warn = (...args) => warnings.push(args.join(" "));

dom.window.crypto = {
  randomUUID: () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  })
};
dom.window.structuredClone = (obj) => JSON.parse(JSON.stringify(obj));

try {
  dom.window.eval(reconCode);
  dom.window.eval(appCode);
} catch (err) {
  errors.push("脚本执行错误: " + err.message);
}

setTimeout(() => {
  const document = dom.window.document;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // 1. 关键元素渲染
  const checks = [
    ["字模库列表", $("#typeList").children.length > 0],
    ["版面格子", $("#stage").children.length > 0],
    ["补字对账汇总", $("#reconSummary").children.length > 0],
    ["缺字汇总", $("#demandList") !== null],
    ["补字单列表", $("#orderList") !== null],
    ["回货核销列表", $("#batchList") !== null],
    ["挂账列表", $("#pendingList") !== null],
    ["抵用余额列表", $("#creditList") !== null],
    ["Toast 元素", $("#toast") !== null]
  ];
  let pass = 0;
  for (const [name, ok] of checks) {
    if (ok) pass++;
    else errors.push(`渲染检查失败: ${name}`);
  }

  // 2. 落字制造缺字：山 库存4 用6 → 缺2
  const shanCard = [...$$("#typeList .type-card")].find((c) => c.querySelector(".glyph").textContent === "山");
  if (!shanCard) {
    errors.push("找不到山字模卡");
  } else {
    shanCard.click();
    for (let i = 0; i < 6; i++) {
      $$("#stage .cell")[i].click();
    }
  }
  if ($$("#demandList .recon-row").length === 0) errors.push("落字后缺字汇总未出现");
  if (!$("#shortageBadge").textContent.includes("缺字")) errors.push("缺字时应显示缺字锁定");

  // 3. 生成补字单
  $("#ensureOrdersBtn").click();
  if ($$("#orderList .recon-row").length === 0) errors.push("生成补字单后补字单列表未出现");

  // 4. 登记回货：山 2 枚
  $("#toggleBatchFormBtn").click();
  const batchLines = $$("#batchLines .batch-line");
  if (batchLines.length > 0) {
    const inputs = batchLines[0].querySelectorAll("input");
    inputs[0].value = "山";
    inputs[1].value = "宋体旧字";
    inputs[2].value = "2";
  }
  $("#receiptNo").value = "HZ-TEST-001";
  $("#batchForm").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));

  const shanCardAfter = [...$$("#typeList .type-card")].find((c) => c.querySelector(".glyph").textContent === "山");
  const qtyInput = shanCardAfter?.querySelector("[data-qty-input]");
  if (!qtyInput || Number(qtyInput.value) !== 6) errors.push(`回货后山库存应为 6，实际为 ${qtyInput?.value}`);
  if ($("#shortageBadge").textContent.includes("缺字")) errors.push("补齐后版面应解锁");
  const orderText = $("#orderList .recon-row")?.textContent || "";
  if (!orderText.includes("已结")) errors.push("回货核销后补字单应已结清");

  // 5. 重复回单只算一次
  const qtyBeforeDup = qtyInput ? Number(qtyInput.value) : 0;
  $("#toggleBatchFormBtn").click();
  const bl2 = $$("#batchLines .batch-line");
  if (bl2.length > 0) {
    const inputs = bl2[0].querySelectorAll("input");
    inputs[0].value = "山";
    inputs[1].value = "宋体旧字";
    inputs[2].value = "2";
  }
  $("#receiptNo").value = "HZ-TEST-001";
  $("#batchForm").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  const shanDup = [...$$("#typeList .type-card")].find((c) => c.querySelector(".glyph").textContent === "山");
  const qtyDup = shanDup?.querySelector("[data-qty-input]");
  if (qtyDup && Number(qtyDup.value) !== qtyBeforeDup) errors.push("重复回单不应增加库存");

  // 6. 多发转抵用：在空细胞再落 1 山（库存6 用7 → 缺1），回货 3 枚
  // 注意：placeType 对同色格子是切换，需点空格子
  for (let i = 6; i < 7; i++) $$("#stage .cell")[i].click();
  $("#ensureOrdersBtn").click();
  $("#toggleBatchFormBtn").click();
  const bl3 = $$("#batchLines .batch-line");
  if (bl3.length > 0) {
    const inputs = bl3[0].querySelectorAll("input");
    inputs[0].value = "山";
    inputs[1].value = "宋体旧字";
    inputs[2].value = "3";
  }
  $("#receiptNo").value = "HZ-TEST-002";
  $("#batchForm").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  if ($$("#creditList .recon-row").length === 0) errors.push("多发后应有抵用余额");

  // 7. 挂账：回一批无未结单的"花"
  $("#toggleBatchFormBtn").click();
  $("#addBatchLineBtn").click();
  const allLines = $$("#batchLines .batch-line");
  const lastLine = allLines[allLines.length - 1];
  const li = lastLine.querySelectorAll("input");
  li[0].value = "花";
  li[1].value = "楷体木刻";
  li[2].value = "5";
  $("#receiptNo").value = "HZ-TEST-003";
  $("#batchForm").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  if ($$("#pendingList .recon-row").length === 0) errors.push("无未结单的回货应挂账");

  // 8. 挂账转抵用
  const pendingBtn = $("#pendingList [data-resolve-pending][data-decision='credit']");
  if (pendingBtn) {
    pendingBtn.click();
    if ($$("#pendingList .recon-row").length !== 0) errors.push("挂账转抵用后挂账列表应清空");
  } else {
    errors.push("找不到挂账转抵用按钮");
  }

  console.log(`\n渲染检查: ${pass}/${checks.length} 通过`);
  if (errors.length) {
    console.log("\n错误:");
    errors.forEach((e) => console.log("  ✗", e));
  }
  if (warnings.length) {
    console.log("\n警告:");
    warnings.forEach((w) => console.log("  ⚠", w));
  }
  console.log(`\n${errors.length === 0 ? "全部通过 ✓" : "存在错误 ✗"}`);
  process.exit(errors.length ? 1 : 0);
}, 100);
