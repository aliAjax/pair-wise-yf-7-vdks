const storageKey = "zfl16-movable-type-workshop";
const backupKey = "zfl16-movable-type-workshop-backup";

const starterInventory = [
  { id: crypto.randomUUID(), char: "山", style: "宋体旧字", size: 30, quantity: 4, wear: "微磨" },
  { id: crypto.randomUUID(), char: "月", style: "宋体旧字", size: 30, quantity: 3, wear: "旧痕" },
  { id: crypto.randomUUID(), char: "风", style: "楷体木刻", size: 28, quantity: 2, wear: "微磨" },
  { id: crypto.randomUUID(), char: "花", style: "楷体木刻", size: 28, quantity: 2, wear: "新" },
  { id: crypto.randomUUID(), char: "茶", style: "黑体铅字", size: 24, quantity: 3, wear: "旧痕" },
  { id: crypto.randomUUID(), char: "雨", style: "仿宋细字", size: 22, quantity: 4, wear: "新" }
];

const defaultState = {
  inventory: starterInventory,
  selectedTypeId: starterInventory[0].id,
  placements: [],
  drafts: [],
  reconciliation: Reconciliation.createState(),
  settings: {
    paperSize: "postcard",
    flowMode: "horizontal",
    gridGap: 8,
    workTitle: "晚风小笺"
  }
};

let state = loadState();

const els = {
  paperSize: document.querySelector("#paperSize"),
  flowMode: document.querySelector("#flowMode"),
  gridGap: document.querySelector("#gridGap"),
  workTitle: document.querySelector("#workTitle"),
  stage: document.querySelector("#stage"),
  typeList: document.querySelector("#typeList"),
  typeForm: document.querySelector("#typeForm"),
  charInput: document.querySelector("#charInput"),
  styleInput: document.querySelector("#styleInput"),
  sizeInput: document.querySelector("#sizeInput"),
  quantityInput: document.querySelector("#quantityInput"),
  wearInput: document.querySelector("#wearInput"),
  inventorySearch: document.querySelector("#inventorySearch"),
  styleFilter: document.querySelector("#styleFilter"),
  selectedTypeLabel: document.querySelector("#selectedTypeLabel"),
  shortageBadge: document.querySelector("#shortageBadge"),
  usageList: document.querySelector("#usageList"),
  draftList: document.querySelector("#draftList"),
  placedCount: document.querySelector("#placedCount"),
  inventoryCount: document.querySelector("#inventoryCount"),
  saveDraftBtn: document.querySelector("#saveDraftBtn"),
  exportBtn: document.querySelector("#exportBtn"),
  clearBoardBtn: document.querySelector("#clearBoardBtn"),
  toast: document.querySelector("#toast"),
  reconSummary: document.querySelector("#reconSummary"),
  ensureOrdersBtn: document.querySelector("#ensureOrdersBtn"),
  toggleBatchFormBtn: document.querySelector("#toggleBatchFormBtn"),
  recoverBtn: document.querySelector("#recoverBtn"),
  batchForm: document.querySelector("#batchForm"),
  batchLines: document.querySelector("#batchLines"),
  addBatchLineBtn: document.querySelector("#addBatchLineBtn"),
  receiptNo: document.querySelector("#receiptNo"),
  batchNote: document.querySelector("#batchNote"),
  demandList: document.querySelector("#demandList"),
  orderList: document.querySelector("#orderList"),
  batchList: document.querySelector("#batchList"),
  pendingList: document.querySelector("#pendingList"),
  creditList: document.querySelector("#creditList"),
  demandCount: document.querySelector("#demandCount"),
  orderCount: document.querySelector("#orderCount"),
  batchCount: document.querySelector("#batchCount"),
  pendingCount: document.querySelector("#pendingCount"),
  creditCount: document.querySelector("#creditCount")
};

let lastSaved = null;
let recoveredFromBackup = false;

function mergeState(parsed) {
  return {
    ...structuredClone(defaultState),
    ...parsed,
    settings: { ...defaultState.settings, ...(parsed.settings || {}) },
    reconciliation: {
      ...Reconciliation.createState(),
      ...(parsed.reconciliation || {})
    }
  };
}

function loadState() {
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    try {
      return mergeState(JSON.parse(saved));
    } catch {
      // 主账损坏，尝试备份
    }
  }
  const backup = localStorage.getItem(backupKey);
  if (backup) {
    try {
      recoveredFromBackup = true;
      return mergeState(JSON.parse(backup));
    } catch {
      // 备份也损坏，用默认
    }
  }
  return structuredClone(defaultState);
}

function saveState() {
  let serialized;
  try {
    serialized = JSON.stringify(state);
  } catch (err) {
    showToast("账本序列化失败，未写入", "warn");
    return;
  }
  try {
    localStorage.setItem(storageKey, serialized);
    try {
      localStorage.setItem(backupKey, serialized);
    } catch {
      // 备份写入失败不影响主账
    }
    lastSaved = new Date();
  } catch (err) {
    // 写入失败 → 恢复上一份账
    const backup = localStorage.getItem(backupKey);
    if (backup) {
      try {
        state = mergeState(JSON.parse(backup));
        showToast("写入失败，已恢复上一份账", "warn");
      } catch {
        showToast("写入失败，且无法恢复备份", "warn");
      }
    } else {
      showToast("写入失败，且无备份可恢复", "warn");
    }
  }
}

function recoverFromBackup() {
  const backup = localStorage.getItem(backupKey);
  if (!backup) {
    showToast("暂无备份可恢复", "info");
    return;
  }
  try {
    state = mergeState(JSON.parse(backup));
    showToast("已恢复上一份账", "ok");
    renderAll();
  } catch {
    showToast("备份损坏，无法恢复", "warn");
  }
}

let toastTimer = null;
function showToast(message, type = "info", duration = 3200) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.className = `toast ${type}`;
  els.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, duration);
}

function getGrid() {
  const size = state.settings.paperSize;
  if (size === "bookmark") return { cols: 7, rows: 18 };
  if (size === "square") return { cols: 12, rows: 12 };
  return { cols: 16, rows: 10 };
}

function placementKey(row, col) {
  return `${row}:${col}`;
}

function getSelectedType() {
  return state.inventory.find((item) => item.id === state.selectedTypeId) || null;
}

function getUsage() {
  return state.placements.reduce((acc, placement) => {
    acc[placement.typeId] = (acc[placement.typeId] || 0) + 1;
    return acc;
  }, {});
}

// 当前版面当作一份草稿参与缺字核算
function boardAsDraft() {
  return {
    id: "__board__",
    title: state.settings.workTitle || "当前版面",
    placements: state.placements
  };
}

// 全部需核算缺字的版面：当前版面 + 已保存草稿
function allDrafts() {
  return [boardAsDraft(), ...state.drafts];
}

// 对账：按版面缺字汇总需求 → 同款字已有未结单接着跟 → 抵用抵扣
function reconcile() {
  const demand = Reconciliation.computeDemand(allDrafts(), state.inventory);
  Reconciliation.ensureOrders(state.reconciliation, demand);
  return { demand, writeOff: Reconciliation.computeWriteOff(state.reconciliation, demand) };
}

function renderSettings() {
  els.paperSize.value = state.settings.paperSize;
  els.flowMode.value = state.settings.flowMode;
  els.gridGap.value = state.settings.gridGap;
  els.workTitle.value = state.settings.workTitle;
}

function renderStyleFilter() {
  const current = els.styleFilter.value || "all";
  const styles = [...new Set(state.inventory.map((item) => item.style))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  els.styleFilter.innerHTML = `<option value="all">全部风格</option>${styles
    .map((style) => `<option value="${escapeHtml(style)}">${escapeHtml(style)}</option>`)
    .join("")}`;
  els.styleFilter.value = styles.includes(current) ? current : "all";
}

function renderInventory() {
  const keyword = els.inventorySearch.value.trim();
  const style = els.styleFilter.value;
  const usage = getUsage();
  const items = state.inventory.filter((item) => {
    const matchesKeyword = !keyword || `${item.char}${item.style}${item.wear}`.includes(keyword);
    const matchesStyle = style === "all" || item.style === style;
    return matchesKeyword && matchesStyle;
  });

  els.inventoryCount.textContent = `${state.inventory.length}枚字模`;
  els.typeList.innerHTML = items
    .map((item) => {
      const used = usage[item.id] || 0;
      const selected = item.id === state.selectedTypeId ? "selected" : "";
      return `
        <article class="type-card ${selected}" draggable="true" data-type-id="${item.id}">
          <div class="glyph" style="font-size:${Math.min(item.size, 36)}px">${escapeHtml(item.char)}</div>
          <div class="type-meta">
            <strong>${escapeHtml(item.char)} · ${escapeHtml(item.style)}</strong>
            <span>${item.size}px · ${escapeHtml(item.wear)} · 已用${used}</span>
            <div class="qty-stepper" title="字模数量（更新后核销结果跟着重算）">
              <button type="button" data-qty-dec="${item.id}" aria-label="减少数量">−</button>
              <input type="number" min="0" value="${item.quantity}" data-qty-input="${item.id}" aria-label="字模数量" />
              <button type="button" data-qty-inc="${item.id}" aria-label="增加数量">+</button>
            </div>
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
          ${type ? escapeHtml(type.char) : ""}
        </button>
      `);
    }
  }
  els.stage.innerHTML = cells.join("");
}

function renderUsage() {
  const usage = getUsage();
  const entries = state.inventory.filter((item) => usage[item.id]);
  els.placedCount.textContent = `${state.placements.length}个落字`;

  const boardShortage = Reconciliation.draftShortage(boardAsDraft(), state.inventory);
  const boardLocked = boardShortage.length > 0;
  els.shortageBadge.textContent = boardLocked ? `缺字锁定 · ${boardShortage.length}款` : "已解锁";
  els.shortageBadge.className = `badge ${boardLocked ? "warn" : "ok"}`;

  const selectedType = getSelectedType();
  els.selectedTypeLabel.textContent = selectedType ? `当前：${selectedType.char} · ${selectedType.style}` : "未选择字模";

  els.usageList.innerHTML =
    entries
      .map((item) => {
        const used = usage[item.id];
        const warn = used > item.quantity ? "warn" : "";
        return `
          <div class="usage-item ${warn}">
            <strong>${escapeHtml(item.char)} ${escapeHtml(item.style)}</strong>
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
        const shortage = Reconciliation.draftShortage(draft, state.inventory);
        const locked = shortage.length > 0;
        const lockTag = locked
          ? `<span class="lock-tag locked" title="缺 ${shortage.map((s) => `${s.char}×${s.count}`).join("、")}，补齐后解锁">缺字锁定</span>`
          : `<span class="lock-tag unlocked">已解锁</span>`;
        return `
          <article class="draft-item">
            <div class="draft-title-row">
              <strong>${escapeHtml(draft.title)}</strong>
              ${lockTag}
            </div>
            <span>${draft.placements.length}个落字 · ${new Date(draft.savedAt).toLocaleString("zh-CN")}</span>
            <div class="draft-actions">
              <button type="button" data-load-draft="${draft.id}">载入</button>
              <button type="button" data-delete-draft="${draft.id}">删除</button>
            </div>
          </article>
        `;
      })
      .join("") || `<p class="empty">还没有保存草稿。</p>`;
}

/* ---------- 补字对账渲染 ---------- */

function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function renderReconciliation() {
  const { demand, writeOff } = reconcile();
  const rc = state.reconciliation;

  // 汇总 chips
  const openDemand = [...demand.values()].reduce((a, d) => a + d.count, 0);
  const openOrders = writeOff.summary.openCount;
  const pendingCount = writeOff.summary.pendingCount;
  const creditTotal = writeOff.summary.creditTotal;
  els.reconSummary.innerHTML = `
    <span class="chip ${openDemand ? "warn" : "ok"}">缺字 ${openDemand} 枚</span>
    <span class="chip">未结补字单 ${openOrders} 张</span>
    <span class="chip ${pendingCount ? "warn" : ""}">挂账 ${pendingCount} 项</span>
    <span class="chip ok">抵用 ${creditTotal} 枚</span>
  `;

  // 缺字汇总
  els.demandCount.textContent = `${demand.size} 款`;
  const demandArr = [...demand.values()].sort((a, b) => b.count - a.count);
  els.demandList.innerHTML =
    demandArr
      .map((d) => {
        const k = Reconciliation.keyOf(d.char, d.style);
        const credit = writeOff.credit.get(k) || 0;
        const open = writeOff.orders.find((o) => Reconciliation.keyOf(o.char, o.style) === k && o.status === "open");
        return `
          <div class="recon-row">
            <div class="row-top">
              <strong>${escapeHtml(d.char)} · ${escapeHtml(d.style)}</strong>
              <span class="tag ${open ? "open" : "settled"}">${open ? "已开单" : "待开单"}</span>
            </div>
            <div class="row-meta">
              <span>缺 ${d.count} 枚</span>
              <span>涉及 ${d.draftCount} 个版面</span>
              ${credit ? `<span>抵用 ${credit}</span>` : ""}
            </div>
          </div>
        `;
      })
      .join("") || `<p class="empty">版面没有缺字。</p>`;

  // 补字单
  els.orderCount.textContent = `${rc.orders.length} 张`;
  const ordersSorted = [...writeOff.orders].sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    return (b.createdAt || "").localeCompare(a.createdAt || "");
  });
  els.orderList.innerHTML =
    ordersSorted
      .map((o) => {
        const pct = Math.round(o.progress * 100);
        return `
          <div class="recon-row">
            <div class="row-top">
              <strong>${escapeHtml(o.char)} · ${escapeHtml(o.style)}</strong>
              <span class="tag ${o.status}">${o.status === "open" ? "未结" : "已结"}</span>
            </div>
            <div class="row-meta">
              <span>已到 ${o.receivedCount}/${o.needCount} 枚</span>
              ${o.remaining ? `<span>还差 ${o.remaining}</span>` : ""}
              ${o.over ? `<span>多出 ${o.over} 转抵用</span>` : ""}
            </div>
            <div class="progress"><i style="width:${pct}%"></i></div>
          </div>
        `;
      })
      .join("") || `<p class="empty">还没有补字单。</p>`;

  // 回货核销
  els.batchCount.textContent = `${rc.batches.length} 批`;
  els.batchList.innerHTML =
    rc.batches
      .map((b) => {
        const lines = b.lines.map((l) => `${escapeHtml(l.char)}·${escapeHtml(l.style)}×${l.count}`).join("，");
        return `
          <div class="recon-row">
            <div class="row-top">
              <strong>回单 ${escapeHtml(b.receiptNo)}</strong>
              <span class="row-meta">${fmtDate(b.receivedAt)}</span>
            </div>
            <div class="row-meta"><span>${lines}</span></div>
            ${b.note ? `<div class="row-meta"><span>${escapeHtml(b.note)}</span></div>` : ""}
          </div>
        `;
      })
      .join("") || `<p class="empty">还没有登记回货。</p>`;

  // 挂账等裁
  const pending = rc.pending.filter((p) => p.status === "pending");
  els.pendingCount.textContent = `${pending.length} 项`;
  els.pendingList.innerHTML =
    pending
      .map((p) => `
        <div class="recon-row">
          <div class="row-top">
            <strong>${escapeHtml(p.char)} · ${escapeHtml(p.style)} × ${p.count}</strong>
            <span class="tag pending">挂账</span>
          </div>
          <div class="row-meta"><span>回单 ${escapeHtml(p.receiptNo)}</span></div>
          <div class="row-actions">
            <button type="button" data-resolve-pending="${p.id}" data-decision="credit">转抵用</button>
            <button type="button" data-resolve-pending="${p.id}" data-decision="wrong">错发销账</button>
          </div>
        </div>
      `)
      .join("") || `<p class="empty">没有挂账。</p>`;

  // 抵用余额
  const credits = [...writeOff.credit.entries()].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  els.creditCount.textContent = `${credits.length} 款`;
  els.creditList.innerHTML =
    credits
      .map(([k, c]) => {
        const [char, style] = k.split("\0");
        return `
          <div class="recon-row">
            <div class="row-top">
              <strong>${escapeHtml(char)} · ${escapeHtml(style)}</strong>
              <span class="tag credit">抵用 ${c}</span>
            </div>
          </div>
        `;
      })
      .join("") || `<p class="empty">没有抵用余额。</p>`;
}

function renderAll() {
  reconcile();
  saveState();
  renderSettings();
  renderStyleFilter();
  renderInventory();
  renderStage();
  renderUsage();
  renderDrafts();
  renderReconciliation();
}

function placeType(row, col, typeId = state.selectedTypeId) {
  if (!typeId) return;
  const existingIndex = state.placements.findIndex((item) => item.row === row && item.col === col);
  if (existingIndex >= 0) {
    if (state.placements[existingIndex].typeId === typeId) {
      state.placements.splice(existingIndex, 1);
    } else {
      state.placements[existingIndex].typeId = typeId;
    }
  } else {
    state.placements.push({ row, col, typeId });
  }
  renderAll();
}

function addType(event) {
  event.preventDefault();
  const item = {
    id: crypto.randomUUID(),
    char: els.charInput.value.trim(),
    style: els.styleInput.value.trim(),
    size: Number(els.sizeInput.value),
    quantity: Number(els.quantityInput.value),
    wear: els.wearInput.value
  };
  if (!item.char || !item.style) return;
  state.inventory.unshift(item);
  state.selectedTypeId = item.id;
  els.typeForm.reset();
  els.sizeInput.value = 24;
  els.quantityInput.value = 3;
  renderAll();
}

function saveDraft() {
  const title = state.settings.workTitle.trim() || "未命名作品";
  state.drafts.unshift({
    id: crypto.randomUUID(),
    title,
    settings: structuredClone(state.settings),
    placements: structuredClone(state.placements),
    savedAt: new Date().toISOString()
  });
  state.drafts = state.drafts.slice(0, 8);
  renderAll();
}

function exportPreview() {
  if (Reconciliation.isDraftLocked(boardAsDraft(), state.inventory)) {
    showToast("当前版面缺字锁定，补齐后才能导出", "warn");
    return;
  }
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

els.paperSize.addEventListener("change", () => {
  state.settings.paperSize = els.paperSize.value;
  const { cols, rows } = getGrid();
  state.placements = state.placements.filter((item) => item.row < rows && item.col < cols);
  renderAll();
});

els.flowMode.addEventListener("change", () => {
  state.settings.flowMode = els.flowMode.value;
  renderAll();
});

els.gridGap.addEventListener("input", () => {
  state.settings.gridGap = Number(els.gridGap.value);
  renderAll();
});

els.workTitle.addEventListener("input", () => {
  state.settings.workTitle = els.workTitle.value;
  saveState();
});

els.typeForm.addEventListener("submit", addType);
els.inventorySearch.addEventListener("input", renderInventory);
els.styleFilter.addEventListener("change", renderInventory);
els.saveDraftBtn.addEventListener("click", saveDraft);
els.exportBtn.addEventListener("click", exportPreview);
els.clearBoardBtn.addEventListener("click", () => {
  state.placements = [];
  renderAll();
});

els.typeList.addEventListener("click", (event) => {
  const decBtn = event.target.closest("[data-qty-dec]");
  const incBtn = event.target.closest("[data-qty-inc]");
  if (decBtn || incBtn) {
    const typeId = (decBtn || incBtn).dataset.qtyDec || (decBtn || incBtn).dataset.qtyInc;
    const item = state.inventory.find((i) => i.id === typeId);
    if (!item) return;
    const delta = incBtn ? 1 : -1;
    item.quantity = Math.max(0, item.quantity + delta);
    renderAll();
    return;
  }
  const deleteButton = event.target.closest("[data-delete-type]");
  if (deleteButton) {
    const typeId = deleteButton.dataset.deleteType;
    state.inventory = state.inventory.filter((item) => item.id !== typeId);
    state.placements = state.placements.filter((item) => item.typeId !== typeId);
    if (state.selectedTypeId === typeId) state.selectedTypeId = state.inventory[0]?.id || null;
    renderAll();
    return;
  }
  const card = event.target.closest("[data-type-id]");
  if (!card) return;
  state.selectedTypeId = card.dataset.typeId;
  renderAll();
});

els.typeList.addEventListener("change", (event) => {
  const input = event.target.closest("[data-qty-input]");
  if (!input) return;
  const item = state.inventory.find((i) => i.id === input.dataset.qtyInput);
  if (!item) return;
  const value = Number(input.value);
  item.quantity = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  renderAll();
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
  if (loadButton) {
    const draft = state.drafts.find((item) => item.id === loadButton.dataset.loadDraft);
    if (!draft) return;
    state.settings = structuredClone(draft.settings);
    state.placements = structuredClone(draft.placements);
    renderAll();
  }
  if (deleteButton) {
    state.drafts = state.drafts.filter((item) => item.id !== deleteButton.dataset.deleteDraft);
    renderAll();
  }
});

/* ---------- 补字对账事件 ---------- */

els.ensureOrdersBtn.addEventListener("click", () => {
  const { demand } = reconcile();
  if (demand.size === 0) {
    showToast("版面没有缺字，无需补字", "info");
    return;
  }
  const summary = Reconciliation.ensureOrders(state.reconciliation, demand);
  const parts = [];
  if (summary.created) parts.push(`新开 ${summary.created} 张补字单`);
  if (summary.updated) parts.push(`跟进 ${summary.updated} 张`);
  if (summary.settled) parts.push(`结清 ${summary.settled} 张`);
  showToast(parts.join("，") || "补字单已是最新", "ok");
  renderAll();
});

els.toggleBatchFormBtn.addEventListener("click", () => {
  const hidden = els.batchForm.hidden;
  els.batchForm.hidden = !hidden;
  if (hidden && els.batchLines.children.length === 0) addBatchLine();
});

els.recoverBtn.addEventListener("click", recoverFromBackup);

els.addBatchLineBtn.addEventListener("click", () => addBatchLine());

function addBatchLine(char = "", style = "", count = 1) {
  const div = document.createElement("div");
  div.className = "batch-line";
  div.innerHTML = `
    <input placeholder="字" class="bl-char" maxlength="2" value="${escapeHtml(char)}" />
    <input placeholder="风格" class="bl-style" value="${escapeHtml(style)}" />
    <input type="number" min="1" class="bl-count" value="${count}" />
    <button type="button" class="remove-line" title="移除该行">×</button>
  `;
  div.querySelector(".remove-line").addEventListener("click", () => div.remove());
  els.batchLines.appendChild(div);
}

els.batchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const receiptNo = els.receiptNo.value.trim();
  const note = els.batchNote.value.trim();
  const lines = [...els.batchLines.querySelectorAll(".batch-line")].map((div) => ({
    char: div.querySelector(".bl-char").value.trim(),
    style: div.querySelector(".bl-style").value.trim(),
    count: Number(div.querySelector(".bl-count").value)
  }));
  const result = Reconciliation.applyBatch(state.reconciliation, state.inventory, receiptNo, lines, note);
  if (!result.ok) {
    showToast(result.reason, "warn");
    return;
  }
  const parts = [`回单 ${receiptNo} 已核销`];
  if (result.addedToInventory.length) {
    parts.push(`到账 ${result.addedToInventory.reduce((a, b) => a + b.count, 0)} 枚`);
  }
  if (result.overDeliveries.length) {
    parts.push(`多发转抵用 ${result.overDeliveries.reduce((a, b) => a + b.count, 0)}`);
  }
  if (result.pendingItems.length) {
    parts.push(`${result.pendingItems.length} 项挂账等裁`);
  }
  showToast(parts.join("，"), "ok");
  els.batchForm.reset();
  els.batchLines.innerHTML = "";
  addBatchLine();
  els.batchForm.hidden = true;
  renderAll();
});

els.pendingList.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-resolve-pending]");
  if (!btn) return;
  const result = Reconciliation.resolvePending(state.reconciliation, btn.dataset.resolvePending, btn.dataset.decision);
  if (!result.ok) {
    showToast(result.reason, "warn");
    return;
  }
  showToast(btn.dataset.decision === "credit" ? "已转抵用" : "已标记错发销账", "ok");
  renderAll();
});

if (recoveredFromBackup) {
  showToast("主账损坏，已从备份恢复上一份账", "warn", 5000);
}

renderAll();
