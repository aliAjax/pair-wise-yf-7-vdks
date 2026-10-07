// 补字对账引擎测试
// 在 node 中模拟 window 环境加载 reconciliation.js
global.window = global;
const fs = require("fs");
const path = require("path");
const code = fs.readFileSync(path.join(__dirname, "reconciliation.js"), "utf8");
eval(code);
const R = global.Reconciliation;

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("FAIL:", msg);
  }
}

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
global.crypto = { randomUUID: uuid };

// 构造测试数据
function makeInventory() {
  return [
    { id: "t1", char: "山", style: "宋体", size: 30, quantity: 4, wear: "新" },
    { id: "t2", char: "月", style: "宋体", size: 30, quantity: 3, wear: "新" },
    { id: "t3", char: "风", style: "楷体", size: 28, quantity: 2, wear: "新" }
  ];
}

function makeDraft(placements) {
  return { id: uuid(), title: "测试草稿", placements };
}

// 测试 1: 缺字汇总
{
  const inv = makeInventory();
  // 山 用了 6 次，库存 4 → 缺 2
  const placements = [];
  for (let i = 0; i < 6; i++) placements.push({ row: 0, col: i, typeId: "t1" });
  const draft = makeDraft(placements);
  const demand = R.computeDemand([draft], inv);
  assert(demand.size === 1, "应有 1 款缺字");
  const d = demand.get(R.keyOf("山", "宋体"));
  assert(d && d.count === 2, "山 缺 2 枚");
  assert(d && d.draftCount === 1, "涉及 1 个版面");
}

// 测试 2: 同款字已有未结单接着跟
{
  const inv = makeInventory();
  const placements = [];
  for (let i = 0; i < 6; i++) placements.push({ row: 0, col: i, typeId: "t1" });
  const draft = makeDraft(placements);
  const rc = R.createState();
  const demand = R.computeDemand([draft], inv);
  R.ensureOrders(rc, demand);
  assert(rc.orders.length === 1, "应开 1 张补字单");
  assert(rc.orders[0].needCount === 2, "补字单 needCount=2");
  // 再来一份草稿，山再缺 1 → 需求变 3，接着跟同一张单
  const placements2 = [];
  for (let i = 0; i < 7; i++) placements2.push({ row: 1, col: i, typeId: "t1" });
  const draft2 = makeDraft(placements2);
  const demand2 = R.computeDemand([draft, draft2], inv);
  R.ensureOrders(rc, demand2);
  assert(rc.orders.length === 1, "同款字应接着跟，不新开单");
  assert(rc.orders[0].needCount === 5, "needCount 应随总需求更新为 5");
}

// 测试 3: 回货核销 + 到账加库存 + 草稿解锁
{
  const inv = makeInventory();
  const placements = [];
  for (let i = 0; i < 6; i++) placements.push({ row: 0, col: i, typeId: "t1" });
  const draft = makeDraft(placements);
  const rc = R.createState();
  const demand = R.computeDemand([draft], inv);
  R.ensureOrders(rc, demand);
  assert(R.isDraftLocked(draft, inv), "补字前草稿应锁定");
  // 回货 2 枚山
  const result = R.applyBatch(rc, inv, "HZ-001", [{ char: "山", style: "宋体", count: 2 }], "第一批");
  assert(result.ok, "回货应成功");
  assert(inv[0].quantity === 6, "到账后山库存应为 6");
  assert(rc.orders[0].status === "settled", "补字单应已结清");
  assert(!R.isDraftLocked(draft, inv), "补齐后草稿应解锁");
}

// 测试 4: 同一份回单只算一次
{
  const inv = makeInventory();
  const rc = R.createState();
  const r1 = R.applyBatch(rc, inv, "HZ-002", [{ char: "山", style: "宋体", count: 1 }]);
  assert(r1.ok, "第一次录入应成功");
  const qtyAfterFirst = inv[0].quantity;
  const r2 = R.applyBatch(rc, inv, "HZ-002", [{ char: "山", style: "宋体", count: 1 }]);
  assert(!r2.ok && r2.duplicate, "重复回单应被拒绝");
  assert(inv[0].quantity === qtyAfterFirst, "重复录入不应增加库存");
  assert(rc.batches.length === 1, "只应有 1 批回货");
}

// 测试 5: 多发转抵用
{
  const inv = makeInventory();
  const placements = [];
  for (let i = 0; i < 6; i++) placements.push({ row: 0, col: i, typeId: "t1" });
  const draft = makeDraft(placements);
  const rc = R.createState();
  const demand = R.computeDemand([draft], inv);
  R.ensureOrders(rc, demand); // needCount=2
  // 回货 5 枚，超出 3
  const result = R.applyBatch(rc, inv, "HZ-003", [{ char: "山", style: "宋体", count: 5 }]);
  assert(result.ok, "回货应成功");
  assert(result.overDeliveries.length === 1 && result.overDeliveries[0].count === 3, "应转 3 枚抵用");
  const credit = R.creditBalance(rc);
  assert(credit.get(R.keyOf("山", "宋体")) === 3, "抵用余额应为 3");
}

// 测试 6: 抵用抵扣未来需求
{
  const inv = makeInventory();
  const rc = R.createState();
  // 先有一笔抵用 3
  rc.creditGrants.push({ id: uuid(), char: "山", style: "宋体", count: 3, source: "over-delivery", sourceId: "x", grantedAt: new Date().toISOString() });
  // 新需求：山缺 5
  const placements = [];
  for (let i = 0; i < 9; i++) placements.push({ row: 0, col: i, typeId: "t1" });
  const draft = makeDraft(placements);
  const demand = R.computeDemand([draft], inv);
  R.ensureOrders(rc, demand);
  assert(rc.orders.length === 1, "应开 1 张单");
  assert(rc.orders[0].needCount === 2, "抵用 3 抵扣后 needCount 应为 2");
}

// 测试 7: 对不上的回货挂账等裁
{
  const inv = makeInventory();
  const rc = R.createState();
  // 没有未结单，回货一批"花"
  const result = R.applyBatch(rc, inv, "HZ-004", [{ char: "花", style: "楷体", count: 4 }]);
  assert(result.ok, "回货应成功");
  assert(result.pendingItems.length === 1, "应有 1 项挂账");
  assert(rc.pending.length === 1 && rc.pending[0].status === "pending", "挂账状态应为 pending");
  // 转抵用
  const r2 = R.resolvePending(rc, rc.pending[0].id, "credit");
  assert(r2.ok, "转抵用应成功");
  assert(rc.pending[0].status === "credit", "挂账状态应为 credit");
  const credit = R.creditBalance(rc);
  assert(credit.get(R.keyOf("花", "楷体")) === 4, "花的抵用余额应为 4");
}

// 测试 8: 字模数量更新后核销结果重算
{
  const inv = makeInventory();
  const placements = [];
  for (let i = 0; i < 6; i++) placements.push({ row: 0, col: i, typeId: "t1" });
  const draft = makeDraft(placements);
  const rc = R.createState();
  const demand = R.computeDemand([draft], inv);
  R.ensureOrders(rc, demand);
  assert(rc.orders[0].needCount === 2, "needCount=2");
  // 用户把库存从 4 改成 5 → 需求变 1
  inv[0].quantity = 5;
  const demand2 = R.computeDemand([draft], inv);
  R.ensureOrders(rc, demand2);
  assert(rc.orders[0].needCount === 1, "库存增加后 needCount 应重算为 1");
  // 再改成 6 → 需求 0，订单结清
  inv[0].quantity = 6;
  const demand3 = R.computeDemand([draft], inv);
  R.ensureOrders(rc, demand3);
  assert(rc.orders[0].status === "settled", "需求清零后订单应结清");
}

// 测试 9: 多款式缺字汇总
{
  const inv = makeInventory();
  const placements = [
    ...Array.from({ length: 6 }, (_, i) => ({ row: 0, col: i, typeId: "t1" })),
    ...Array.from({ length: 5 }, (_, i) => ({ row: 1, col: i, typeId: "t2" }))
  ];
  const draft = makeDraft(placements);
  const demand = R.computeDemand([draft], inv);
  assert(demand.size === 2, "应有 2 款缺字");
  assert(demand.get(R.keyOf("山", "宋体")).count === 2, "山缺 2");
  assert(demand.get(R.keyOf("月", "宋体")).count === 2, "月缺 2");
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
