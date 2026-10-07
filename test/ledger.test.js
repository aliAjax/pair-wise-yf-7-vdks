// 补字账房冒烟测试：node test/ledger.test.js
// 覆盖：缺字汇总、跟单、分批核销、回单幂等、溢发抵用、挂账裁决、
//       草稿锁定/解锁、数量联动重算、写入失败回滚、持久化读回
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// ---- 浏览器环境桩 ----
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    if (localStorage.shouldFail) throw new Error("磁盘满（模拟）");
    store.set(k, String(v));
  },
  removeItem: (k) => store.delete(k),
  shouldFail: false
};

function makeElement() {
  return {
    style: {},
    dataset: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    appendChild() {},
    insertAdjacentHTML() {},
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    closest: () => null,
    reset() {},
    _html: "",
    _text: "",
    set innerHTML(value) {
      this._html = value;
    },
    get innerHTML() {
      return this._html;
    },
    set textContent(value) {
      this._text = value;
    },
    get textContent() {
      return this._text;
    },
    hidden: false
  };
}

const sandbox = {
  console,
  localStorage,
  crypto: require("node:crypto").webcrypto,
  structuredClone: (v) => JSON.parse(JSON.stringify(v)),
  Date,
  JSON,
  Math,
  Number,
  String,
  Set,
  Map,
  document: {
    querySelector: () => makeElement(),
    createElement: () => ({
      getContext: () => ({ fillRect() {}, strokeRect() {}, fillText() {} }),
      toDataURL: () => "data:image/png;base64,"
    })
  },
  module: { exports: {} }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8"), sandbox);

const api = sandbox.module.exports;
const { actions, defaultState, migrate, reloadState, persist } = api;

// ---- 每例重置为一块干净全局账：山×2、月×5 ----
function resetWorld() {
  store.clear();
  localStorage.shouldFail = false;
  const s = reloadState();
  s.inventory = [
    { id: "type-shan", char: "山", style: "宋体旧字", size: 30, quantity: 2, wear: "新" },
    { id: "type-yue", char: "月", style: "宋体旧字", size: 30, quantity: 5, wear: "新" }
  ];
  s.placements = [];
  s.drafts = [];
  s.orders = [];
  s.receipts = [];
  s.credits = [];
  s.suspense = [];
  s.seq = { order: 0 };
  return s;
}

let passed = 0;
function test(name, fn) {
  const s = resetWorld();
  try {
    fn(s);
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

const place = (s, typeId, n) => {
  const start = s.placements.length;
  for (let i = 0; i < n; i += 1) s.placements.push({ row: 0, col: start + i, typeId });
};

console.log("补字账房账规测试");

test("1. 按版面汇总缺字（同字同款合并）", (s) => {
  place(s, "type-shan", 3);
  const rows = actions.computeShortages();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].char, "山");
  assert.equal(rows[0].gap, 1); // 用3存2
  assert.equal(rows[0].need, 1);
});

test("2. 同款字有未结单就接着跟（不另开新单、不重复下单）", (s) => {
  place(s, "type-shan", 3);
  actions.requestAllCasts();
  assert.equal(s.orders.length, 1);
  assert.equal(s.orders[0].lines[0].qty, 1);
  place(s, "type-shan", 2); // 缺口扩大到3
  actions.requestAllCasts();
  assert.equal(s.orders.length, 1, "仍是同一张单");
  assert.equal(s.orders[0].lines.length, 1, "仍是同一行");
  assert.equal(s.orders[0].lines[0].qty, 3, "追加增量，累计3");
});

test("3. 分批交货逐批核销，结清后单子关闭", (s) => {
  place(s, "type-shan", 5);
  actions.requestAllCasts(); // 缺3
  actions.receiveGoods({ no: "R-1", foundry: "东市", lines: [{ char: "山", style: "宋体旧字", qty: 2 }] });
  let view = actions.computeOrdersView();
  assert.equal(view[0].closed, false);
  assert.equal(view[0].delivered, 2);
  assert.equal(s.inventory[0].quantity, 4);
  actions.receiveGoods({ no: "R-2", lines: [{ char: "山", style: "宋体旧字", qty: 1 }] });
  view = actions.computeOrdersView();
  assert.equal(view[0].closed, true);
  assert.equal(s.inventory[0].quantity, 5);
  assert.equal(actions.computeShortages().length, 0);
});

test("4. 同一回单号贴两次只核销一次", (s) => {
  place(s, "type-shan", 4);
  actions.requestAllCasts(); // 缺2
  assert.ok(actions.receiveGoods({ no: "DUP", lines: [{ char: "山", style: "宋体旧字", qty: 2 }] }));
  assert.throws(
    () => actions.receiveGoods({ no: "DUP", lines: [{ char: "山", style: "宋体旧字", qty: 2 }] }),
    /重复贴单/
  );
  assert.equal(s.receipts.length, 1);
  assert.equal(s.inventory[0].quantity, 4);
});

test("5. 多发的存为抵用不进常库；下次托铸先冲抵，不足再立单", (s) => {
  actions.receiveGoods({ no: "OVER", lines: [{ char: "山", style: "宋体旧字", qty: 3 }] });
  assert.equal(s.inventory[0].quantity, 2, "常库不增");
  assert.equal(actions.computeCredits().get("山||宋体旧字"), 3);
  place(s, "type-shan", 6); // 缺4
  const rows = actions.computeShortages();
  assert.equal(rows[0].gap, 4);
  assert.equal(rows[0].credit, 3);
  assert.equal(rows[0].need, 1, "缺口4被抵用3冲后只需再托铸1");
  actions.requestAllCasts();
  assert.equal(s.inventory[0].quantity, 5, "抵用3转入常库 2+3");
  assert.equal(actions.computeCredits().get("山||宋体旧字"), 0);
  assert.equal(s.orders.length, 1);
  assert.equal(s.orders[0].lines[0].qty, 1, "只托铸剩余1枚");
});

test("6. 单内溢交也入抵用", (s) => {
  place(s, "type-shan", 3);
  actions.requestAllCasts(); // 缺1
  actions.receiveGoods({ no: "OVER2", lines: [{ char: "山", style: "宋体旧字", qty: 4 }] });
  assert.equal(s.inventory[0].quantity, 3, "核销1入库");
  assert.equal(actions.computeCredits().get("山||宋体旧字"), 3, "溢3入抵用");
  assert.equal(actions.computeOrdersView()[0].closed, true);
});

test("7. 对不上先挂账，可裁为抵用或退回", (s) => {
  actions.receiveGoods({ no: "MYSTERY", lines: [{ char: "龙", style: "篆书古刻", qty: 2 }] });
  assert.equal(s.suspense.length, 1);
  assert.equal(s.inventory.find((i) => i.char === "龙"), undefined, "不入库");
  assert.equal(s.receipts[0].lines[0].kind, "suspense");
  actions.resolveSuspense(s.suspense[0].id, "credit");
  assert.equal(s.suspense[0].resolved, true);
  assert.equal(actions.computeCredits().get("龙||篆书古刻"), 2);
  // 另一款挂账退回：不产生抵用
  actions.receiveGoods({ no: "M2", lines: [{ char: "鹤", style: "篆书古刻", qty: 1 }] });
  const pending = s.suspense.find((item) => item.receiptNo === "M2");
  actions.resolveSuspense(pending.id, "return");
  assert.equal(actions.computeCredits().get("鹤||篆书古刻"), undefined);
});

test("8. 草稿缺口锁定，补字到账后缺口清零才解锁", (s) => {
  s.drafts = [
    {
      id: "d1",
      title: "远山稿",
      settings: s.settings,
      placements: [],
      savedAt: new Date().toISOString()
    }
  ];
  for (let i = 0; i < 4; i += 1) s.drafts[0].placements.push({ row: 0, col: i, typeId: "type-shan" });
  let status = actions.computeDraftStatus(s.drafts[0]);
  assert.equal(status.locked, true);
  assert.equal(status.shortages[0].gap, 2);
  // 托铸立单 → 回货核销 2 枚进常库
  place(s, "type-shan", 4);
  actions.requestAllCasts();
  actions.receiveGoods({ no: "UNLOCK", lines: [{ char: "山", style: "宋体旧字", qty: 2 }] });
  assert.equal(s.inventory[0].quantity, 4);
  status = actions.computeDraftStatus(s.drafts[0]);
  assert.equal(status.locked, false, "缺口清零，解锁");
});

test("9. 一张回单多行分摊核销，字模数量一变缺口重算", (s) => {
  place(s, "type-shan", 3); // 山缺1
  place(s, "type-yue", 7); // 月缺2
  actions.requestAllCasts();
  assert.equal(s.orders[0].lines.length, 2);
  const receipt = actions.receiveGoods({
    no: "MIX",
    lines: [
      { char: "山", style: "宋体旧字", qty: 1 },
      { char: "月", style: "宋体旧字", qty: 2 }
    ]
  });
  assert.equal(receipt.lines.filter((l) => l.kind === "order").length, 2);
  assert.equal(actions.computeOrdersView()[0].closed, true);
  assert.equal(actions.computeShortages().length, 0);
  // 手动把库存减下去，缺口立刻重算回来
  actions.adjustQuantity("type-shan", -2);
  assert.equal(actions.computeShortages()[0].gap, 2);
});

test("10. 关掉再开能读回（含旧版本迁移容错）", (s) => {
  place(s, "type-shan", 3);
  actions.requestAllCasts();
  persist(s);
  const raw = JSON.parse(store.get("zfl16-movable-type-workshop"));
  assert.equal(raw.orders.length, 1);
  const reloaded = reloadState();
  assert.equal(reloaded.orders.length, 1);
  assert.equal(reloaded.inventory[0].char, "山");
  assert.equal(actions.computeOrdersView()[0].lines[0].qty, 1);
  const migrated = migrate({ inventory: [], placements: [], drafts: [] });
  assert.ok(Array.isArray(migrated.orders));
  assert.equal(migrated.version, 2);
});

test("11. 写入失败：主账不动，重新开账读回仍是上一份", (s) => {
  persist(s); // 先存一份无单旧账
  const beforeRaw = store.get("zfl16-movable-type-workshop");
  s.orders.push({ id: "ghost", no: "BZ-9999", lines: [] });
  localStorage.shouldFail = true;
  assert.throws(() => persist(s), /磁盘满/);
  localStorage.shouldFail = false;
  assert.equal(store.get("zfl16-movable-type-workshop"), beforeRaw);
  const restored = reloadState();
  assert.equal(restored.orders.length, 0);
});

console.log(`\n${passed} 项全部通过`);
