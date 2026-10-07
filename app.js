// 活字排版工坊 —— 排版台 + 补字账房
// 账务原则：
//  1. 缺额 / 核销 / 抵用 / 草稿锁 全部由「源数据」派生，字模数量一变即重算
//  2. 补字单按「字+风格」跟未结单，回货逐批核销，回单号幂等
//  3. 溢发不进常库，入抵用；下次托铸先冲抵；对不上的挂账待裁
//  4. 所有写入走 commit()：先改内存，主存储写入失败则整体回滚并恢复上一份账

const storageKey = "zfl16-movable-type-workshop";
const backupStorageKey = "zfl16-movable-type-workshop.backup";
const version = 2;

const uid = () =>
  crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const starterInventory = [
  { id: uid(), char: "山", style: "宋体旧字", size: 30, quantity: 4, wear: "微磨" },
  { id: uid(), char: "月", style: "宋体旧字", size: 30, quantity: 3, wear: "旧痕" },
  { id: uid(), char: "风", style: "楷体木刻", size: 28, quantity: 2, wear: "微磨" },
  { id: uid(), char: "花", style: "楷体木刻", size: 28, quantity: 2, wear: "新" },
  { id: uid(), char: "茶", style: "黑体铅字", size: 24, quantity: 3, wear: "旧痕" },
  { id: uid(), char: "雨", style: "仿宋细字", size: 22, quantity: 4, wear: "新" }
];

function defaultState() {
  return {
    version,
    inventory: structuredClone(starterInventory),
    selectedTypeId: starterInventory[0]?.id || null,
    placements: [],
    drafts: [],
    settings: { paperSize: "postcard", flowMode: "horizontal", gridGap: 8, workTitle: "晚风小笺" },
    orders: [],       // 外协补字单
    receipts: [],     // 回货回单（每张含逐行核销结果）
    credits: [],      // 溢发抵用流水（balance 实时派生于流水）
    suspense: [],     // 挂账待裁
    seq: { order: 0 }
  };
}

// ---------- 持久化：主备双份，失败回滚 ----------

function migrate(parsed) {
  const base = defaultState();
  const state = { ...base, ...parsed, settings: { ...base.settings, ...(parsed.settings || {}) } };
  state.orders ||= [];
  state.receipts ||= [];
  state.credits ||= [];
  state.suspense ||= [];
  state.seq ||= { order: 0 };
  state.version = version;
  return state;
}

function loadState() {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) return migrate(JSON.parse(saved));
    const backup = localStorage.getItem(backupStorageKey);
    if (backup) return migrate(JSON.parse(backup));
  } catch (error) {
    // 主账损坏：退回上一份
    try {
      const backup = localStorage.getItem(backupStorageKey);
      if (backup) return migrate(JSON.parse(backup));
    } catch {
      /* 双份皆坏，开新账 */
    }
  }
  return defaultState();
}

function persist(snapshot) {
  const raw = JSON.stringify(snapshot);
  // 先备份当前主账，再写新主账；任一步失败由调用方回滚内存
  const previous = localStorage.getItem(storageKey);
  if (previous !== null) localStorage.setItem(backupStorageKey, previous);
  localStorage.setItem(storageKey, raw);
}

let state = loadState();

// commit：内存改完算一遍，落盘失败就恢复上一份账并抛错；成功后重算全部派生账
function commit(mutator) {
  const snapshot = structuredClone(state);
  const result = typeof mutator === "function" ? mutator(state) : mutator;
  try {
    persist(state);
  } catch (error) {
    state = snapshot;
    throw new Error(`账本写入失败，已恢复上一份账：${error.message}`);
  }
  renderAll(); // 字模数量 / 回货一变，缺额、核销、草稿锁全部跟着重算
  return result;
}

// ---------- 键与归并 ----------

const keyOf = (char, style) => `${char}||${style}`;
const splitKey = (key) => {
  const at = key.indexOf("||");
  return { char: key.slice(0, at), style: key.slice(at + 2) };
};
const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const getGrid = () => {
  const size = state.settings.paperSize;
  if (size === "bookmark") return { cols: 7, rows: 18 };
  if (size === "square") return { cols: 12, rows: 12 };
  return { cols: 16, rows: 10 };
};
const placementKey = (row, col) => `${row}:${col}`;
const getSelectedType = () => state.inventory.find((item) => item.id === state.selectedTypeId) || null;

// 版面按「字+风格」归并用模（同字同风格的不同字模可通用）
function computeUsedByKey() {
  const used = new Map();
  for (const placement of state.placements) {
    const type = state.inventory.find((item) => item.id === placement.typeId);
    if (!type) continue;
    const key = keyOf(type.char, type.style);
    used.set(key, (used.get(key) || 0) + 1);
  }
  return used;
}

function computeOnHand() {
  const onHand = new Map();
  for (const item of state.inventory) {
    const key = keyOf(item.char, item.style);
    onHand.set(key, (onHand.get(key) || 0) + item.quantity);
  }
  return onHand;
}

// 补字单每行的已交数量：全部回单核销流水求和（逐批核销的派生存根）
function computeDeliveredByLine() {
  const delivered = new Map();
  for (const receipt of state.receipts) {
    for (const line of receipt.lines) {
      if (line.kind === "order" && line.lineId) {
        delivered.set(line.lineId, (delivered.get(line.lineId) || 0) + line.qty);
      }
    }
  }
  return delivered;
}

function orderStatus(order, deliveredByLine) {
  const ordered = order.lines.reduce((sum, line) => sum + line.qty, 0);
  const delivered = order.lines.reduce((sum, line) => sum + (deliveredByLine.get(line.id) || 0), 0);
  return { ordered, delivered, closed: delivered >= ordered };
}

function computeOrdersView() {
  const deliveredByLine = computeDeliveredByLine();
  return state.orders.map((order) => ({
    order,
    ...orderStatus(order, deliveredByLine),
    lines: order.lines.map((line) => ({
      ...line,
      delivered: deliveredByLine.get(line.id) || 0,
      remaining: Math.max(0, line.qty - (deliveredByLine.get(line.id) || 0))
    }))
  }));
}

// 未结补字单按「字+风格」的缺口（每行）
function computeOpenByKey() {
  const view = computeOrdersView();
  const open = new Map();
  for (const item of view) {
    if (item.closed) continue;
    for (const line of item.lines) {
      if (line.remaining <= 0) continue;
      if (!open.has(line.key)) open.set(line.key, []);
      open.get(line.key).push({ order: item.order, line, remaining: line.remaining });
    }
  }
  return open;
}

// 抵用余额：溢发存入为正，托铸冲抵为负
function computeCredits() {
  const balance = new Map();
  for (const event of state.credits) {
    balance.set(event.key, (balance.get(event.key) || 0) + event.delta);
  }
  return balance;
}

// 缺字汇总：缺口、抵用、在途（未结单余量）、仍需托铸
function computeShortages() {
  const used = computeUsedByKey();
  const onHand = computeOnHand();
  const credits = computeCredits();
  const openByKey = computeOpenByKey();
  const rows = [];
  for (const [key, usedQty] of used) {
    const have = onHand.get(key) || 0;
    const gap = Math.max(0, usedQty - have);
    if (gap <= 0) continue;
    const credit = Math.max(0, credits.get(key) || 0);
    const inTransit = (openByKey.get(key) || []).reduce((sum, item) => sum + item.remaining, 0);
    // 待托铸 = 总缺口 − 抵用（抵用上限为缺口）。有未结单时，新增量再减去在途、追加到原单。
    const need = Math.max(0, gap - Math.min(credit, gap));
    rows.push({
      key,
      ...splitKey(key),
      used: usedQty,
      onHand: have,
      gap,
      credit,
      inTransit,
      need,
      openEntries: openByKey.get(key) || []
    });
  }
  return rows.sort((a, b) => b.gap - a.gap || a.char.localeCompare(b.char, "zh-CN"));
}

// 草稿的缺字按它自己保存的落字重算
function computeDraftStatus(draft) {
  const onHand = computeOnHand();
  const missing = new Map();
  for (const placement of draft.placements) {
    const type = state.inventory.find((item) => item.id === placement.typeId);
    if (!type) {
      // 字模已删除也按缺模计：用占位键
      const key = keyOf("？", "已删字模");
      missing.set(key, (missing.get(key) || 0) + 1);
      continue;
    }
    const key = keyOf(type.char, type.style);
    missing.set(key, (missing.get(key) || 0) + 1);
  }
  const shortages = [];
  for (const [key, qty] of missing) {
    const gap = Math.max(0, qty - (onHand.get(key) || 0));
    if (gap > 0) shortages.push({ key, ...splitKey(key), qty, onHand: onHand.get(key) || 0, gap });
  }
  return { locked: shortages.length > 0, shortages };
}

// 给常库某款字加量（已有的字模加枚数），没有就建一款新字模
function addStock(key, qty, size = 24) {
  const { char, style } = splitKey(key);
  const existing = state.inventory.find((item) => item.char === char && item.style === style);
  if (existing) {
    existing.quantity += qty;
  } else {
    state.inventory.unshift({ id: uid(), char, style, size, quantity: qty, wear: "新" });
  }
}

// ---------- 业务动作 ----------

class LedgerError extends Error {}

function nextOrderNo() {
  state.seq.order += 1;
  return `BZ-${String(state.seq.order).padStart(4, "0")}`;
}

// 托铸：一键把全部缺口送外协。同款字有未结单接着跟，抵用先冲抵
function requestAllCasts() {
  const shortages = computeShortages().filter((row) => row.need > 0);
  if (!shortages.length) return { ordered: 0 };

  // 抵用冲抵：对每个缺口，把抵用余额（最多抵到缺口清零）转入常库
  for (const row of shortages) {
    if (row.credit <= 0) continue;
    const cover = Math.min(row.credit, row.gap);
    if (cover <= 0) continue;
    addStock(row.key, cover);
    state.credits.push({
      id: uid(),
      key: row.key,
      delta: -cover,
      reason: "托铸冲抵",
      at: new Date().toISOString()
    });
    // 抵用已冲 cover 枚，重算冲抵后的真实缺口（在途单未变）
    row.need = Math.max(0, row.gap - cover - row.inTransit);
  }

  const created = [];
  const appended = [];
  // 本次抵用冲抵枚数（每个缺口最多抵到缺口清零）
  const creditCovered = shortages.reduce((sum, row) => sum + Math.min(row.credit, row.gap), 0);
  for (const row of shortages) {
    if (row.need <= 0) continue;
    const entries = row.openEntries;
    if (entries.length) {
      // 接着跟：只补「总缺口 − 已托铸在途」的增量，追加到最早一张未结单同款行
      const delta = Math.max(0, row.need - row.inTransit);
      if (delta <= 0) continue;
      const { order, line } = entries[0];
      const rawLine = order.lines.find((candidate) => candidate.id === line.id);
      rawLine.qty += delta;
      order.updatedAt = new Date().toISOString();
      appended.push({ key: row.key, qty: delta, orderNo: order.no });
    } else {
      created.push({ key: row.key, qty: row.need });
    }
  }

  if (created.length) {
    const order = {
      id: uid(),
      no: nextOrderNo(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lines: created.map((item) => ({
        id: uid(),
        key: item.key,
        qty: item.qty,
        origin: "托铸"
      }))
    };
    state.orders.unshift(order);
  }

  return { ordered: shortages.length, appended, createdCount: created.length, creditCovered };
}

// 登记回单：同号只算一次；逐行核销；溢发存抵用；对不上挂账
function receiveGoods({ no, foundry, lines }) {
  const receiptNo = String(no || "").trim();
  if (!receiptNo) throw new LedgerError("回单号不能为空");
  if (state.receipts.some((receipt) => receipt.no === receiptNo)) {
    throw new LedgerError(`回单 ${receiptNo} 已登记过，重复贴单只核销一次`);
  }
  const cleanLines = lines
    .map((line) => ({ char: String(line.char || "").trim(), style: String(line.style || "").trim(), qty: Number(line.qty) }))
    .filter((line) => line.char && line.style && line.qty > 0);
  if (!cleanLines.length) throw new LedgerError("回单上没有可核销的字款行");

  const openByKey = computeOpenByKey();
  const processed = [];

  for (const line of cleanLines) {
    const key = keyOf(line.char, line.style);
    let qty = line.qty;
    const entries = (openByKey.get(key) || []).filter((entry) => entry.remaining > 0);

    if (entries.length) {
      // 逐行核销未结补字单，一张回单可跨行、跨单分摊
      const allocations = [];
      for (const entry of entries) {
        if (qty <= 0) break;
        const take = Math.min(qty, entry.remaining);
        allocations.push({ orderId: entry.order.id, orderNo: entry.order.no, lineId: entry.line.id, qty: take });
        entry.remaining -= take;
        qty -= take;
      }
      addStock(key, line.qty - qty);
      for (const allocation of allocations) {
        processed.push({ ...allocation, key, qty: allocation.qty, kind: "order" });
      }
      if (qty > 0) {
        // 单内多交的部分：入抵用（不进常库）
        state.credits.push({
          id: uid(),
          key,
          delta: qty,
          reason: `回单${receiptNo}溢发`,
          refReceiptNo: receiptNo,
          at: new Date().toISOString()
        });
        processed.push({ key, qty, kind: "credit", note: "超未结单，溢发抵用" });
      }
    } else if (state.inventory.some((item) => keyOf(item.char, item.style) === key)) {
      // 无未结单、但本坊有这款字：整批算溢发
      state.credits.push({
        id: uid(),
        key,
        delta: qty,
        reason: `回单${receiptNo}溢发`,
        refReceiptNo: receiptNo,
        at: new Date().toISOString()
      });
      processed.push({ key, qty, kind: "credit", note: "无未结单，溢发抵用" });
    } else {
      // 无单且无此款字：对不上，挂账等裁（不入库、不抵用）
      const suspenseId = uid();
      state.suspense.push({
        id: suspenseId,
        key,
        qty,
        receiptNo,
        at: new Date().toISOString(),
        resolved: false
      });
      processed.push({ key, qty, kind: "suspense", suspenseId, note: "对不上，挂账待裁" });
    }
  }

  const receipt = {
    id: uid(),
    no: receiptNo,
    foundry: String(foundry || "").trim(),
    at: new Date().toISOString(),
    lines: processed
  };
  state.receipts.unshift(receipt);
  return receipt;
}

// 挂账裁决：收入抵用 / 退回
function resolveSuspense(id, action) {
  const item = state.suspense.find((entry) => entry.id === id);
  if (!item || item.resolved) return;
  item.resolved = true;
  item.resolvedAt = new Date().toISOString();
  item.action = action;
  if (action === "credit") {
    state.credits.push({
      id: uid(),
      key: item.key,
      delta: item.qty,
      reason: `挂账${item.receiptNo}裁为抵用`,
      refSuspenseId: item.id,
      at: new Date().toISOString()
    });
  }
}

// 手动调整字模枚数（字模数量一变，缺额与核销结果随之重算）
function adjustQuantity(typeId, delta) {
  const item = state.inventory.find((entry) => entry.id === typeId);
  if (!item) return null;
  item.quantity = Math.max(0, item.quantity + delta);
  if (item.quantity === 0) {
    state.placements = state.placements.filter((placement) => placement.typeId !== typeId);
  }
  return item.quantity;
}

// 关掉再开：从主存储（或备份）读回上一份账
function reloadState() {
  state = loadState();
  return state;
}

// ---------- DOM ----------

const $ = (selector) => document.querySelector(selector);
const els = {
  paperSize: $("#paperSize"),
  flowMode: $("#flowMode"),
  gridGap: $("#gridGap"),
  workTitle: $("#workTitle"),
  stage: $("#stage"),
  typeList: $("#typeList"),
  typeForm: $("#typeForm"),
  charInput: $("#charInput"),
  styleInput: $("#styleInput"),
  sizeInput: $("#sizeInput"),
  quantityInput: $("#quantityInput"),
  wearInput: $("#wearInput"),
  inventorySearch: $("#inventorySearch"),
  styleFilter: $("#styleFilter"),
  selectedTypeLabel: $("#selectedTypeLabel"),
  shortageBadge: $("#shortageBadge"),
  usageList: $("#usageList"),
  draftList: $("#draftList"),
  placedCount: $("#placedCount"),
  inventoryCount: $("#inventoryCount"),
  saveDraftBtn: $("#saveDraftBtn"),
  exportBtn: $("#exportBtn"),
  clearBoardBtn: $("#clearBoardBtn"),
  boardView: $("#boardView"),
  ledgerView: $("#ledgerView"),
  tabBoard: $("#tabBoard"),
  tabLedger: $("#tabLedger"),
  ledgerAlert: $("#ledgerAlert"),
  shortageList: $("#shortageList"),
  requestAllBtn: $("#requestAllBtn"),
  draftUnlockList: $("#draftUnlockList"),
  draftUnlockCount: $("#draftUnlockCount"),
  orderList: $("#orderList"),
  orderCount: $("#orderCount"),
  receiptForm: $("#receiptForm"),
  receiptNoInput: $("#receiptNoInput"),
  foundryInput: $("#foundryInput"),
  receiptLines: $("#receiptLines"),
  addRowBtn: $("#addRowBtn"),
  fillOutstandingBtn: $("#fillOutstandingBtn"),
  receiptError: $("#receiptError"),
  receiptList: $("#receiptList"),
  receiptCount: $("#receiptCount"),
  creditList: $("#creditList"),
  creditCount: $("#creditCount"),
  suspenseList: $("#suspenseList"),
  suspenseCount: $("#suspenseCount"),
  toastHost: $("#toastHost")
};

let activeTab = "board";

// ---------- 排版台渲染 ----------

function renderSettings() {
  els.paperSize.value = state.settings.paperSize;
  els.flowMode.value = state.settings.flowMode;
  els.gridGap.value = state.settings.gridGap;
  els.workTitle.value = state.settings.workTitle;
}

function renderStyleFilter() {
  const current = els.styleFilter.value || "all";
  const styles = [...new Set(state.inventory.map((item) => item.style))].sort((a, b) =>
    a.localeCompare(b, "zh-CN")
  );
  els.styleFilter.innerHTML =
    `<option value="all">全部风格</option>` +
    styles.map((style) => `<option value="${esc(style)}">${esc(style)}</option>`).join("");
  els.styleFilter.value = styles.includes(current) ? current : "all";
}

function renderInventory() {
  const keyword = els.inventorySearch.value.trim();
  const style = els.styleFilter.value;
  const usedById = new Map();
  for (const placement of state.placements) {
    usedById.set(placement.typeId, (usedById.get(placement.typeId) || 0) + 1);
  }
  const items = state.inventory.filter((item) => {
    const matchesKeyword = !keyword || `${item.char}${item.style}${item.wear}`.includes(keyword);
    const matchesStyle = style === "all" || item.style === style;
    return matchesKeyword && matchesStyle;
  });

  els.inventoryCount.textContent = `${state.inventory.length}枚字模`;
  els.typeList.innerHTML = items
    .map((item) => {
      const used = usedById.get(item.id) || 0;
      const selected = item.id === state.selectedTypeId ? "selected" : "";
      const low = used > item.quantity ? "low" : "";
      return `
        <article class="type-card ${selected} ${low}" draggable="true" data-type-id="${item.id}">
          <div class="glyph" style="font-size:${Math.min(item.size, 36)}px">${esc(item.char)}</div>
          <div class="type-meta">
            <strong>${esc(item.char)} · ${esc(item.style)}</strong>
            <span>${item.size}px · ${esc(item.wear)} · 已用${used}/${item.quantity}</span>
            <span class="qty-stepper">
              <button type="button" class="step-btn" data-qty="-1" data-type="${item.id}" title="字模减一枚">−</button>
              <button type="button" class="step-btn" data-qty="1" data-type="${item.id}" title="字模加一枚">＋</button>
            </span>
          </div>
          <button class="mini-btn" title="删除字模" data-delete-type="${item.id}" type="button">×</button>
        </article>
      `;
    })
    .join("");
}

function renderStage() {
  const { cols, rows } = getGrid();
  const map = new Map(state.placements.map((item) => [placementKey(item.row, item.col), item]));
  els.stage.className = `stage ${state.settings.paperSize}`;
  els.stage.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  els.stage.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  els.stage.style.gap = `${state.settings.gridGap}px`;
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const placement = map.get(placementKey(row, col));
      const type = placement ? state.inventory.find((item) => item.id === placement.typeId) : null;
      const vertical = state.settings.flowMode === "vertical" ? "vertical" : "";
      cells.push(`
        <button class="cell ${type ? "used" : ""} ${vertical}" data-row="${row}" data-col="${col}" type="button" aria-label="第${row + 1}行第${col + 1}列">
          ${type ? esc(type.char) : ""}
        </button>
      `);
    }
  }
  els.stage.innerHTML = cells.join("");
}

function renderUsage() {
  const usedById = new Map();
  for (const placement of state.placements) {
    usedById.set(placement.typeId, (usedById.get(placement.typeId) || 0) + 1);
  }
  const entries = state.inventory.filter((item) => usedById.get(item.id));
  els.placedCount.textContent = `${state.placements.length}个落字`;

  const shortages = entries.filter((item) => usedById.get(item.id) > item.quantity);
  els.shortageBadge.textContent = shortages.length ? `${shortages.length}处缺字 · 去账房补字` : "数量充足";
  els.shortageBadge.className = `badge ${shortages.length ? "warn" : "ok"}`;
  els.shortageBadge.style.cursor = shortages.length ? "pointer" : "default";

  const selectedType = getSelectedType();
  els.selectedTypeLabel.textContent = selectedType
    ? `当前：${selectedType.char} · ${selectedType.style}`
    : "未选择字模";

  els.usageList.innerHTML =
    entries
      .map((item) => {
        const used = usedById.get(item.id);
        const warn = used > item.quantity ? "warn" : "";
        return `
          <div class="usage-item ${warn}">
            <strong>${esc(item.char)} ${esc(item.style)}</strong>
            <span>${used}/${item.quantity}</span>
          </div>
        `;
      })
      .join("") || `<p class="empty">还没有落字。</p>`;
}

function renderDrafts() {
  els.draftList.innerHTML =
    state.drafts
      .map((draft) => {
        const { locked, shortages } = computeDraftStatus(draft);
        const lockLine = locked
          ? shortages.map((item) => `${esc(item.char)}·${esc(item.style)}缺${item.gap}`).join("，")
          : "";
        return `
          <article class="draft-item ${locked ? "locked" : ""}">
            <strong>${esc(draft.title)} ${locked ? '<span class="lock-tag">缺口未清 · 锁定</span>' : '<span class="unlock-tag">可载入</span>'}</strong>
            <span>${draft.placements.length}个落字 · ${fmtTime(draft.savedAt)}</span>
            ${locked ? `<span class="lock-detail">${lockLine}</span>` : ""}
            <div class="draft-actions">
              <button type="button" data-load-draft="${draft.id}" ${locked ? "disabled" : ""}>${locked ? "解锁后可载入" : "载入"}</button>
              <button type="button" data-delete-draft="${draft.id}">删除</button>
            </div>
          </article>
        `;
      })
      .join("") || `<p class="empty">还没有保存草稿。</p>`;
}

// ---------- 账房渲染 ----------

function fmtTime(iso) {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function renderShortages() {
  const rows = computeShortages();
  if (!rows.length) {
    els.shortageList.innerHTML = `<p class="empty">版面没有缺字，账房清净。</p>`;
    els.requestAllBtn.disabled = true;
    return;
  }
  els.requestAllBtn.disabled = false;
  els.shortageList.innerHTML = rows
    .map(
      (row) => `
      <div class="ledger-row">
        <div class="ledger-glyph">${esc(row.char)}<small>${esc(row.style)}</small></div>
        <div class="ledger-nums">
          <span>需用 <b>${row.used}</b></span>
          <span>在库 <b>${row.onHand}</b></span>
          <span class="gap">缺口 <b>${row.gap}</b></span>
          <span class="credit-num">抵用 ${row.credit}</span>
          <span class="transit-num">在途 ${row.inTransit}</span>
          <span class="need-num">待托铸 <b>${row.need}</b></span>
        </div>
      </div>`
    )
    .join("");
}

function renderDraftUnlock() {
  const rows = state.drafts.map((draft) => ({ draft, ...computeDraftStatus(draft) }));
  const lockedCount = rows.filter((row) => row.locked).length;
  els.draftUnlockCount.textContent = lockedCount ? `${lockedCount}份锁定中` : "全部可载入";
  if (!rows.length) {
    els.draftUnlockList.innerHTML = `<p class="empty">暂无草稿。</p>`;
    return;
  }
  els.draftUnlockList.innerHTML = rows
    .map(
      ({ draft, locked, shortages }) => `
      <article class="draft-item ${locked ? "locked" : ""}">
        <strong>${esc(draft.title)} ${locked ? '<span class="lock-tag">锁定</span>' : '<span class="unlock-tag">已解锁</span>'}</strong>
        <span>${draft.placements.length}个落字</span>
        ${
          locked
            ? `<span class="lock-detail">${shortages
                .map((item) => `${esc(item.char)}·${esc(item.style)}缺${item.gap}`)
                .join("，")}</span>`
            : `<span class="lock-detail ok">缺口已清，可回排版台载入。</span>`
        }
      </article>`
    )
    .join("");
}

function renderOrders() {
  const view = computeOrdersView();
  const openCount = view.filter((item) => !item.closed).length;
  els.orderCount.textContent = openCount ? `${openCount}单未结 / 共${view.length}单` : `共${view.length}单`;
  if (!view.length) {
    els.orderList.innerHTML = `<p class="empty">还没有补字单。先在版面落字造成缺字，再「一键托铸」。</p>`;
    return;
  }
  els.orderList.innerHTML = view
    .map((item) => {
      const statusTag = item.closed
        ? '<span class="order-tag closed">已结清</span>'
        : '<span class="order-tag open">未结</span>';
      return `
        <article class="order-card ${item.closed ? "closed" : ""}">
          <header>
            <strong>补字单 ${esc(item.order.no)}</strong>
            ${statusTag}
            <span class="muted">立单 ${fmtTime(item.order.createdAt)}</span>
            <span class="muted">已交 ${item.delivered}/${item.ordered}</span>
          </header>
          <div class="order-lines">
            ${item.lines
              .map((line) => {
                const { char, style } = splitKey(line.key);
                return `
                  <span class="order-line ${line.remaining ? "pending" : "done"}">
                    ${esc(char)}·${esc(style)} ×${line.qty}
                    <small>已交${line.delivered}${line.remaining ? ` · 欠${line.remaining}` : ""}</small>
                  </span>`;
              })
              .join("")}
          </div>
        </article>`;
    })
    .join("");
}

function receiptRowHtml(char = "", style = "", qty = "") {
  return `
    <div class="receipt-line-row">
      <input class="rl-char" maxlength="4" placeholder="字" value="${esc(char)}" />
      <input class="rl-style" placeholder="风格" value="${esc(style)}" />
      <input class="rl-qty" type="number" min="1" max="999" placeholder="枚数" value="${qty}" />
      <button type="button" class="step-btn" data-remove-row title="删行">×</button>
    </div>`;
}

function renderReceiptForm() {
  if (!els.receiptLines.children.length) els.receiptLines.innerHTML = receiptRowHtml();
}

function collectReceiptLines() {
  return [...els.receiptLines.querySelectorAll(".receipt-line-row")].map((row) => ({
    char: row.querySelector(".rl-char").value,
    style: row.querySelector(".rl-style").value,
    qty: row.querySelector(".rl-qty").value
  }));
}

function renderReceipts() {
  els.receiptCount.textContent = state.receipts.length ? `${state.receipts.length}张回单` : "";
  if (!state.receipts.length) {
    els.receiptList.innerHTML = `<p class="empty">还没有回货回单。</p>`;
    return;
  }
  els.receiptList.innerHTML = state.receipts
    .map(
      (receipt) => `
      <article class="receipt-card">
        <header>
          <strong>回单 ${esc(receipt.no)}</strong>
          <span class="muted">${receipt.foundry ? esc(receipt.foundry) + " · " : ""}${fmtTime(receipt.at)}</span>
        </header>
        <ul class="writeoff-lines">
          ${receipt.lines
            .map((line) => {
              const { char, style } = splitKey(line.key);
              const label =
                line.kind === "order"
                  ? `核销 ${esc(line.orderNo)}`
                  : line.kind === "credit"
                    ? "溢发抵用"
                    : "挂账待裁";
              return `<li class="wline ${line.kind}">${esc(char)}·${esc(style)} ×${line.qty} <b>${label}</b></li>`;
            })
            .join("")}
        </ul>
      </article>`
    )
    .join("");
}

function renderCredits() {
  const balance = computeCredits();
  const rows = [...balance.entries()].filter(([, qty]) => qty !== 0);
  els.creditCount.textContent = rows.length ? `${rows.length}款有抵用` : "";
  if (!rows.length) {
    els.creditList.innerHTML = `<p class="empty">暂无溢发抵用。</p>`;
    return;
  }
  els.creditList.innerHTML = rows
    .map(([key, qty]) => {
      const { char, style } = splitKey(key);
      return `<div class="ledger-row compact"><span class="ledger-glyph small">${esc(char)}<small>${esc(style)}</small></span><b class="credit-num">抵用 ${qty} 枚</b></div>`;
    })
    .join("");
}

function renderSuspense() {
  const pending = state.suspense.filter((item) => !item.resolved);
  els.suspenseCount.textContent = pending.length ? `${pending.length}笔待裁` : "";
  els.ledgerAlert.hidden = pending.length === 0;
  if (!state.suspense.length) {
    els.suspenseList.innerHTML = `<p class="empty">没有对不上的回货。</p>`;
    return;
  }
  els.suspenseList.innerHTML = state.suspense
    .map((item) => {
      const { char, style } = splitKey(item.key);
      if (item.resolved) {
        return `
          <article class="suspense-card resolved">
            <strong>${esc(char)}·${esc(style)} ×${item.qty}</strong>
            <span class="muted">回单${esc(item.receiptNo)} · 已${item.action === "credit" ? "裁为抵用" : "退回"}</span>
          </article>`;
      }
      return `
        <article class="suspense-card">
          <strong>${esc(char)}·${esc(style)} ×${item.qty}</strong>
          <span class="muted">回单${esc(item.receiptNo)} · 无单无此款字</span>
          <div class="suspense-actions">
            <button type="button" data-suspense="${item.id}" data-action="credit">收入抵用</button>
            <button type="button" data-suspense="${item.id}" data-action="return">退回铸字房</button>
          </div>
        </article>`;
    })
    .join("");
}

// ---------- 总渲染 ----------

function renderAll(toast) {
  renderSettings();
  renderStyleFilter();
  renderInventory();
  renderStage();
  renderUsage();
  renderDrafts();
  renderShortages();
  renderDraftUnlock();
  renderOrders();
  renderReceiptForm();
  renderReceipts();
  renderCredits();
  renderSuspense();
  if (toast) showToast(toast.ok, toast.error);
}

let toastTimer = null;
function showToast(message, isError = false) {
  if (!message) return;
  els.toastHost.textContent = message;
  els.toastHost.className = `toast-host show ${isError ? "error" : "ok"}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toastHost.classList.remove("show");
  }, 2600);
}

// 所有动作统一过 try/commit，失败提示且内存账已回滚；toast 由调用方给文案
function run(mutator, message) {
  try {
    const result = commit(mutator);
    showToast(typeof message === "function" ? message(result) : message);
    return result;
  } catch (error) {
    showToast(error.message, true);
    return null;
  }
}

// ---------- 排版台交互 ----------

function placeType(row, col, typeId = state.selectedTypeId) {
  if (!typeId) return;
  commit((draft) => {
    const existingIndex = draft.placements.findIndex((item) => item.row === row && item.col === col);
    if (existingIndex >= 0) {
      if (draft.placements[existingIndex].typeId === typeId) draft.placements.splice(existingIndex, 1);
      else draft.placements[existingIndex].typeId = typeId;
    } else {
      draft.placements.push({ row, col, typeId });
    }
  });
}

function addType(event) {
  event.preventDefault();
  const item = {
    id: uid(),
    char: els.charInput.value.trim(),
    style: els.styleInput.value.trim(),
    size: Number(els.sizeInput.value),
    quantity: Number(els.quantityInput.value),
    wear: els.wearInput.value
  };
  if (!item.char || !item.style) return;
  run((draft) => {
    draft.inventory.unshift(item);
    draft.selectedTypeId = item.id;
  }, `字模「${item.char}·${item.style}」已入库`);
  els.typeForm.reset();
  els.sizeInput.value = 24;
  els.quantityInput.value = 3;
}

function saveDraft() {
  const title = state.settings.workTitle.trim() || "未命名作品";
  run((draft) => {
    draft.drafts.unshift({
      id: uid(),
      title,
      settings: structuredClone(draft.settings),
      placements: structuredClone(draft.placements),
      savedAt: new Date().toISOString()
    });
    draft.drafts = draft.drafts.slice(0, 12);
  }, "草稿已保存");
}

function exportPreview() {
  const { cols, rows } = getGrid();
  const cell = state.settings.paperSize === "bookmark" ? 44 : 56;
  const gap = state.settings.gridGap;
  const margin = 48;
  const width = cols * cell + (cols - 1) * gap + margin * 2;
  const height = rows * cell + (rows - 1) * gap + margin * 2 + 70;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fffaf1";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#2f2921";
  ctx.lineWidth = 4;
  ctx.strokeRect(18, 18, width - 36, height - 36);
  ctx.fillStyle = "#22201c";
  ctx.font = "bold 28px sans-serif";
  ctx.fillText(state.settings.workTitle || "未命名作品", margin, 50);
  ctx.font = "bold 30px serif";
  state.placements.forEach((placement) => {
    const type = state.inventory.find((item) => item.id === placement.typeId);
    if (!type) return;
    const x = margin + placement.col * (cell + gap);
    const y = margin + 45 + placement.row * (cell + gap);
    ctx.fillStyle = "#2f2921";
    ctx.fillRect(x, y, cell, cell);
    ctx.fillStyle = "#fff5df";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `900 ${Math.min(type.size + 8, 42)}px serif`;
    ctx.fillText(type.char, x + cell / 2, y + cell / 2);
  });
  const link = document.createElement("a");
  link.download = `${state.settings.workTitle || "movable-type"}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

// ---------- 事件绑定 ----------

function init() {
  els.paperSize.addEventListener("change", () => {
    commit((draft) => {
      draft.settings.paperSize = els.paperSize.value;
      const { cols, rows } = getGrid();
      draft.placements = draft.placements.filter((item) => item.row < rows && item.col < cols);
    });
  });

  els.flowMode.addEventListener("change", () => {
    commit((draft) => {
      draft.settings.flowMode = els.flowMode.value;
    });
  });

  els.gridGap.addEventListener("input", () => {
    state.settings.gridGap = Number(els.gridGap.value);
    renderStage();
    try {
      persist(state);
    } catch {
      showToast("账本写入失败，已保留上一份账", true);
    }
  });

  els.workTitle.addEventListener("input", () => {
    state.settings.workTitle = els.workTitle.value;
    try {
      persist(state);
    } catch {
      showToast("账本写入失败，已保留上一份账", true);
    }
  });

  els.typeForm.addEventListener("submit", addType);
  els.inventorySearch.addEventListener("input", renderInventory);
  els.styleFilter.addEventListener("change", renderInventory);
  els.saveDraftBtn.addEventListener("click", saveDraft);
  els.exportBtn.addEventListener("click", exportPreview);
  els.clearBoardBtn.addEventListener("click", () => run((draft) => (draft.placements = []), "版面已清空"));

  els.shortageBadge.addEventListener("click", () => {
    if (els.shortageBadge.classList.contains("warn")) switchTab("ledger");
  });

  els.tabBoard.addEventListener("click", () => switchTab("board"));
  els.tabLedger.addEventListener("click", () => switchTab("ledger"));

  els.typeList.addEventListener("click", (event) => {
    const stepButton = event.target.closest("[data-qty]");
    if (stepButton) {
      const { type, qty } = stepButton.dataset;
      run(
        () => adjustQuantity(type, Number(qty)),
        (result) => (result ? `字模数量已更新为 ${result} 枚，缺口与核销已重算` : "数量未变")
      );
      return;
    }
    const deleteButton = event.target.closest("[data-delete-type]");
    if (deleteButton) {
      const typeId = deleteButton.dataset.deleteType;
      run((draft) => {
        draft.inventory = draft.inventory.filter((item) => item.id !== typeId);
        draft.placements = draft.placements.filter((item) => item.typeId !== typeId);
        if (draft.selectedTypeId === typeId) draft.selectedTypeId = draft.inventory[0]?.id || null;
      }, "字模已删除，缺字已重算");
      return;
    }
    const card = event.target.closest("[data-type-id]");
    if (!card) return;
    state.selectedTypeId = card.dataset.typeId;
    renderInventory();
    renderUsage();
    try {
      persist(state);
    } catch {
      /* 选择态落盘失败不阻断操作 */
    }
  });

  els.typeList.addEventListener("dragstart", (event) => {
    const card = event.target.closest("[data-type-id]");
    if (!card) return;
    event.dataTransfer.setData("text/plain", card.dataset.typeId);
  });

  els.stage.addEventListener("dragover", (event) => {
    if (event.target.closest(".cell")) event.preventDefault();
  });

  els.stage.addEventListener("drop", (event) => {
    const cell = event.target.closest(".cell");
    if (!cell) return;
    event.preventDefault();
    placeType(Number(cell.dataset.row), Number(cell.dataset.col), event.dataTransfer.getData("text/plain"));
  });

  els.stage.addEventListener("click", (event) => {
    const cell = event.target.closest(".cell");
    if (!cell) return;
    placeType(Number(cell.dataset.row), Number(cell.dataset.col));
  });

  els.draftList.addEventListener("click", (event) => {
    const loadButton = event.target.closest("[data-load-draft]");
    const deleteButton = event.target.closest("[data-delete-draft]");
    if (loadButton && !loadButton.disabled) {
      run(
        (draft) => {
          const saved = draft.drafts.find((item) => item.id === loadButton.dataset.loadDraft);
          if (!saved) return;
          draft.settings = structuredClone(saved.settings);
          draft.placements = structuredClone(saved.placements);
        },
        "草稿已载入版面"
      );
    }
    if (deleteButton) {
      run((draft) => {
        draft.drafts = draft.drafts.filter((item) => item.id !== deleteButton.dataset.deleteDraft);
      }, "草稿已删除");
    }
  });

  // ---- 账房交互 ----
  els.requestAllBtn.addEventListener("click", () => {
    run(
      () => requestAllCasts(),
      (result) => {
        if (!result || !result.ordered) return "缺口已有抵用或在途覆盖，无需托铸";
        const parts = [];
        if (result.creditCovered) parts.push(`抵用冲账${result.creditCovered}枚`);
        if (result.createdCount) parts.push(`新立${result.createdCount}单`);
        if (result.appended.length) parts.push(`追加${result.appended.length}款到未结单`);
        return parts.length ? `托铸完成：${parts.join("，")}` : "缺口已被抵用与在途覆盖";
      }
    );
  });

  els.addRowBtn.addEventListener("click", () => {
    els.receiptLines.insertAdjacentHTML("beforeend", receiptRowHtml());
  });

  els.receiptLines.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-row]");
    if (!button) return;
    const row = button.closest(".receipt-line-row");
    if (els.receiptLines.children.length > 1) row.remove();
  });

  els.fillOutstandingBtn.addEventListener("click", () => {
    const view = computeOrdersView();
    const rows = [];
    for (const item of view) {
      if (item.closed) continue;
      for (const line of item.lines) {
        if (line.remaining > 0) {
          const { char, style } = splitKey(line.key);
          rows.push({ char, style, qty: line.remaining });
        }
      }
    }
    if (!rows.length) {
      showToast("未结单上没有待交的字");
      return;
    }
    els.receiptLines.innerHTML = rows.map((row) => receiptRowHtml(row.char, row.style, row.qty)).join("");
  });

  els.receiptForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = {
      no: els.receiptNoInput.value,
      foundry: els.foundryInput.value,
      lines: collectReceiptLines()
    };
    const receipt = run(() => receiveGoods(input), (result) => {
      if (!result) return "";
      const counts = result.lines.reduce(
        (acc, line) => {
          acc[line.kind] += 1;
          return acc;
        },
        { order: 0, credit: 0, suspense: 0 }
      );
      return `回单 ${result.no} 已核销${counts.order ? ` · 销账${counts.order}行` : ""}${
        counts.credit ? ` · 溢发${counts.credit}行入抵用` : ""
      }${counts.suspense ? ` · ${counts.suspense}行挂账待裁` : ""}`;
    });
    if (receipt) {
      els.receiptForm.reset();
      els.receiptLines.innerHTML = receiptRowHtml();
      els.receiptError.hidden = true;
    }
  });

  els.suspenseList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-suspense]");
    if (!button) return;
    run(
      () => resolveSuspense(button.dataset.suspense, button.dataset.action),
      button.dataset.action === "credit" ? "已收入抵用" : "已标记退回铸字房"
    );
  });

  renderAll();
}

function switchTab(tab) {
  activeTab = tab;
  els.boardView.hidden = tab !== "board";
  els.ledgerView.hidden = tab !== "ledger";
  els.tabBoard.classList.toggle("active", tab === "board");
  els.tabLedger.classList.toggle("active", tab === "ledger");
}

// 浏览器中启动；Node（require 冒烟测试）下只导出纯逻辑
if (typeof document !== "undefined" && typeof module === "undefined") {
  init();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    defaultState,
    migrate,
    keyOf,
    loadState,
    reloadState,
    persist,
    commit,
    actions: {
      requestAllCasts,
      receiveGoods,
      resolveSuspense,
      adjustQuantity,
      computeShortages,
      computeOrdersView,
      computeCredits,
      computeDraftStatus
    }
  };
}
