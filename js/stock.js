// ── STOCK ───────────────────────────────────────────────────────────────────
// Admin-only tab: shows stock rows from an external spreadsheet.
// Pills: Available | Cost Sheet | Sold | Undelivered.
// Available view is a four-level tree — Device > Brand > Model > Specs — and
// each level collapses to one row showing its name, its unit count and the
// summed Cost Price of everything under it. Undelivered is two levels —
// Model > Specs. Cost Sheet is a flat roll-up: one row per Device/Model/Specs
// holding the HIGHEST cost seen, for units that have both an order and a
// selling date. A leaf in the Available view also carries Check (copy IMEI_1
// and open the brand's activation page), Add/Edit date, and Sell; a leaf whose
// Activation date is filled is tinted amber until the sale is logged.

let _stock = { headers: [], rows: [] };
let _stockLoaded = false;
let _stockFilter = 'available';
// True while the IMEI search box holds a query. Used by the builders to ignore
// collapsed groups, so a matching unit is never hidden inside a closed group.
let _stockSearchActive = false;
// Admin-only actions. The Stock tab itself can be shared read-only through
// perms.stock, so every action cell and the "+" button follow this flag.
let _stockCanEdit = false;
// Row object -> index in _stock.rows. Builders use it to send the exact sheet
// row for stage 2 (an undelivered unit has no IMEI to identify it by yet).
let _stockRowMap = new Map();
let _stockDeliveryCtx = null;
let _stockSellCtx = null;
let _stockPushTimer = null;

// device name -> true when that Device group is collapsed (Available view)
let _stockCollapsedD = {};
let _stockCollapsedB = {}; // 'Device||Brand' -> true when that Brand group is collapsed
let _stockCollapsedMod = {}; // 'Device||Brand||Model' -> collapsed Model group
let _stockCollapsedSpec = {}; // 'Device||Brand||Model||Specs' -> collapsed Specs group
let _stockCollapsedM = {}; // 'Month Sold' -> true when that month's rows are collapsed (Sold view)
let _stockCollapsedUM = {}; // Undelivered view: model name -> collapsed
let _stockCollapsedUS = {}; // Undelivered view: 'Model||Specs' -> collapsed
let _stockDeviceNames = [];
let _stockBrandKeys = [];
let _stockModelKeys = [];
let _stockSpecKeys = [];
let _stockMonthKeys = [];
let _stockUModelKeys = [];
let _stockUSpecKeys = [];

const _STOCK_AMT_COLS = ['cost price', 'selling price', 'kunal telecom', 'aks share'];

const _STOCK_DISPLAY = {
  available:   { cols: ['Device','Brand','Model','Specs','IMEI_1','IMEI_2','Activation Date','Cost Price'] },
  costsheet:   { cols: ['Device','Model','Specs','Cost Price'] },
  sold:        { cols: ['Month Sold','Selling Date','Model','Specs','Customer Name','Payment Mode','IMEI_1','Cost Price','Selling Price','Kunal Telecom','AKS Share'] },
  undelivered: { cols: ['Model','Specs','Order Date','Marketplace','Paid By','Cost Price'] },
};

// Order the pills are offered in, and the keys renderStock understands.
const _STOCK_FILTERS = ['available', 'costsheet', 'sold', 'undelivered'];

// Columns sorted in descending order per view
const _STOCK_SORT_DESC = {
  sold:        { 'Month Sold': true, 'Selling Date': true },
  undelivered: { 'Order Date': true },
};

async function initStockPage() {
  setStockFilter('available');
  _syncStockFab();
  await loadStock();
}

function setStockFilter(f) {
  _stockFilter = f;
  document.querySelectorAll('#stock-pills .stock-tab').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-f') === f);
  });
  renderStock();
}

function onStockSearchInput() {
  debounced(renderStock, 'stock-search', 200);
}

function clearStockSearch() {
  const inp = $('stock-search');
  if (!inp) return;
  inp.value = '';
  renderStock();
  inp.focus();
}

async function loadStock() {
  // Every snapshot already carries stock: pushSnapshot() runs readStock with
  // forceRefresh=1, and readStock opens the other spreadsheet itself by ID
  // (SpreadsheetApp.openById(STOCK_SHEET_ID)), so a separate worksheet is no
  // obstacle. Paint it and return — zero network calls.
  //
  // Exception: a direct stock write (order/delivered/sold) stamps
  // aks_stock_wrote_at. If the snapshot we hold was generated before that
  // write, it is stale — read the sheet instead of painting old inventory.
  // _stockLoaded covers the in-session case where applyStock already holds the
  // fresh table handed back by the write response.
  if (S.snapStock && S.snapStock.headers && (_stockLoaded || !_stockSnapshotIsStale())) {
    applyStock(S.snapStock);
    if (!_stock.headers.length) showAlert('Stock sheet is empty.', 'e');
    return;
  }
  // Fallback: snapshot never landed (or the Worker is down). Keep the old
  // behaviour rather than show nothing.
  showLoader();
  let wasEmpty = false;
  try {
    const res = await gasGet('readStock');
    if (!res.ok) { showAlert('Failed to load stock: ' + (res.error || ''), 'e'); return; }
    applyStock(res.stock);
    wasEmpty = !_stock.headers.length;
    if (wasEmpty) showAlert('Stock sheet is empty.', 'e');
  } catch (err) {
    showAlert('Failed to load stock: ' + err.message, 'e');
  } finally {
    hideLoader();
  }
  // Background force-refresh — updates the view quietly if data changed.
  gasGet('readStock', { forceRefresh: '1' }).then(res => {
    if (res && res.ok && res.stock && res.stock.headers) {
      applyStock(res.stock);
      if (!res.stock.headers.length && !wasEmpty) showAlert('Stock sheet is empty.', 'e');
    }
  }).catch(() => {});
}

function applyStock(stock) {
  stock = (stock && stock.headers) ? stock : { headers: [], rows: [] };
  // The sheet has two columns for payment info: 'Paid By' (bank/UPI) and 'Payment Mode' (Cash/AKS Fin).
  // They may both be named 'Payment Mode' or both 'Paid By' in the sheet.
  // Normalize: first occurrence → 'Paid By', second → 'Payment Mode'.
  const pmIndices = [];
  for (let i = 0; i < stock.headers.length; i++) {
    const h = String(stock.headers[i]).toLowerCase();
    if (h === 'payment mode' || h === 'paid by') pmIndices.push(i);
  }
  if (pmIndices.length >= 2) {
    stock.headers[pmIndices[0]] = 'Paid By';
    stock.headers[pmIndices[1]] = 'Payment Mode';
  }
  // The column was renamed in the sheet; accept either spelling so the tab
  // keeps working whether or not the header cell has been updated yet.
  for (let i = 0; i < stock.headers.length; i++) {
    if (String(stock.headers[i]).trim().toLowerCase() === 'specification') stock.headers[i] = 'Specs';
  }
  _stock = stock;
  _stockLoaded = true;
  renderStock();
}

// ── STOCK ACTIONS (admin only) ──────────────────────────────────────────────
// Three lifecycle stages write straight to the Stock sheet through Apps Script,
// deliberately bypassing the approval layer: inventory is a log, not a loan
// submission. The server re-checks the Users-sheet role, so hiding the buttons
// here is a convenience, never the security boundary.

// The Stock tab can be shared read-only via perms.stock. Only a real admin gets
// the "＋", "Sell" and "Deliver" controls.
function _stockIsAdmin() {
  return !!(S.cu && S.cu.role === 'admin');
}

function _syncStockFab() {
  const admin = _stockIsAdmin();
  const fab = $('stock-fab');
  if (fab) fab.style.display = admin ? 'flex' : 'none';
  // The activation checker is an admin tool as well. Hiding it here keeps a
  // read-only Stock tab clean without a second admin check in activation.js.
  const bar = $('act-toolbar');
  if (bar) bar.style.display = admin ? 'flex' : 'none';
}

// Local calendar date as YYYY-MM-DD. toISOString() is UTC, which is the
// previous day for the first 5.5 hours of an IST morning.
function _todayYMD() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

// A direct stock write stamps aks_stock_wrote_at. Any snapshot generated at or
// before that moment is older than the sheet, so loadStock() must not paint it.
function _stockSnapshotIsStale() {
  let wrote = 0;
  try { wrote = parseInt(localStorage.getItem('aks_stock_wrote_at') || '0', 10) || 0; } catch (e) {}
  if (!wrote) return false;
  return !S.snapshotAt || S.snapshotAt <= wrote;
}

function _markStockWrote() {
  try { localStorage.setItem('aks_stock_wrote_at', String(Date.now())); } catch (e) {}
}

// Unique, sorted, non-empty values of one Stock column — the choices offered by
// the order modal. 'Paid By' resolves to the first payment column, exactly like
// the rest of this file, because the sheet may name it 'Payment Mode'.
function _stockUniqueValues(header) {
  const i = header === 'Paid By' ? _paidByCol(_stock.headers) : _colIndex(_stock.headers, header);
  if (i < 0) return [];
  const seen = {};
  const out = [];
  _stock.rows.forEach(r => {
    const val = String(r[i] == null ? '' : r[i]).trim();
    if (val && !seen[val]) { seen[val] = true; out.push(val); }
  });
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function _fillStockSelect(selectId, header) {
  const sel = $(selectId);
  if (!sel) return;
  const opts = ['<option value="">Select…</option>'];
  _stockUniqueValues(header).forEach(val => {
    opts.push('<option value="' + _esc(val) + '">' + _esc(val) + '</option>');
  });
  opts.push('<option value="__other__">Other</option>');
  sel.innerHTML = opts.join('');
}

// Reveal the free-text box when "Other" is picked. Clearing it on any other
// choice stops a previously typed name from being submitted by accident.
function onStockSelectChange(selectId) {
  const sel = $(selectId);
  const wrap = $(selectId + '-other-wrap');
  if (!sel || !wrap) return;
  const isOther = sel.value === '__other__';
  wrap.style.display = isOther ? '' : 'none';
  if (!isOther) {
    const inp = $(selectId + '-other');
    if (inp) inp.value = '';
  }
}

function _stockSelectValue(selectId) {
  const sel = $(selectId);
  if (!sel) return '';
  if (sel.value === '__other__') return v(selectId + '-other');
  return String(sel.value || '').trim();
}

// Paint the fresh table the write response carried back. If the response had no
// stock payload (the write landed but the follow-up read failed) fall back to a
// normal load rather than leaving stale inventory on screen.
function _refreshStockAfterWrite(stock) {
  _markStockWrote();
  if (stock && stock.headers) {
    applyStock(stock);
  } else {
    _stockLoaded = false;
    loadStock();
  }
  _scheduleStockSnapshotPush();
}

// Debounced: three quick writes should rebuild the shared Worker snapshot once.
// The write itself is already committed; this only keeps other devices current.
function _scheduleStockSnapshotPush() {
  if (_stockPushTimer) clearTimeout(_stockPushTimer);
  _stockPushTimer = setTimeout(async () => {
    _stockPushTimer = null;
    try {
      const r = await gasPost({ action: 'pushSnapshotNow' }, { priority: PRIORITY.push });
      if (r && r.ok && typeof refreshSnapshot === 'function') {
        _snapRefreshP = null;
        refreshSnapshot();
      }
    } catch (e) { /* the next periodic push will catch up */ }
  }, 2500);
}

// ── Stage 1: log a newly ordered unit ───────────────────────────────────────
function openStockOrderModal() {
  if (!_stockIsAdmin()) { showAlert('Admin only.', 'e'); return; }
  if (!_stock.headers.length) { showAlert('Stock sheet is empty.', 'e'); return; }
  $('so-date').value = _todayYMD();
  $('so-cost').value = '';
  const selects = ['so-device', 'so-brand', 'so-model', 'so-specs', 'so-marketplace', 'so-paidby'];
  _fillStockSelect('so-device', 'Device');
  _fillStockSelect('so-brand', 'Brand');
  _fillStockSelect('so-model', 'Model');
  _fillStockSelect('so-specs', 'Specs');
  _fillStockSelect('so-marketplace', 'Marketplace');
  _fillStockSelect('so-paidby', 'Paid By');
  selects.forEach(id => {
    onStockSelectChange(id);
    const inp = $(id + '-other');
    if (inp) inp.value = '';
  });
  $('stock-order-modal').style.display = 'flex';
}

function closeStockOrderModal() {
  const m = $('stock-order-modal');
  if (m) m.style.display = 'none';
}

async function submitStockOrder() {
  if (!_stockIsAdmin()) { showAlert('Admin only.', 'e'); return; }
  const orderDate   = v('so-date');
  const costRaw     = v('so-cost');
  const device      = _stockSelectValue('so-device');
  const brand       = _stockSelectValue('so-brand');
  const model       = _stockSelectValue('so-model');
  const specs       = _stockSelectValue('so-specs');
  const marketplace = _stockSelectValue('so-marketplace');
  const paidBy      = _stockSelectValue('so-paidby');
  const cost        = parseFloat(costRaw);

  if (!orderDate)   { showAlert('Order Date is required.', 'e'); return; }
  if (!device)      { showAlert('Device is required.', 'e'); return; }
  if (!brand)       { showAlert('Brand is required.', 'e'); return; }
  if (!model)       { showAlert('Model is required.', 'e'); return; }
  if (!specs)       { showAlert('Specification is required.', 'e'); return; }
  if (costRaw === '' || isNaN(cost)) { showAlert('Cost Price must be a number.', 'e'); return; }
  if (!marketplace) { showAlert('Marketplace is required.', 'e'); return; }
  if (!paidBy)      { showAlert('Paid By is required.', 'e'); return; }

  const btn = $('so-submit');
  if (btn) btn.disabled = true;
  showLoader();
  try {
    const res = await gasPost({
      action: 'addStockOrder',
      orderDate, device, brand, model, specs,
      costPrice: cost, marketplace, paidBy,
    });
    if (!res || !res.ok) {
      showAlert('Could not save order: ' + ((res && res.error) || 'Unknown error'), 'e');
      return;
    }
    closeStockOrderModal();
    showAlert('Order logged.', 's');
    _refreshStockAfterWrite(res.stock);
  } catch (err) {
    showAlert('Could not save order: ' + err.message, 'e');
  } finally {
    hideLoader();
    if (btn) btn.disabled = false;
  }
}

// ── Stage 2: mark an undelivered unit delivered ─────────────────────────────
// Undelivered units have no IMEI yet, so the row is identified by its position
// in _stock.rows plus the Order Date it showed. The server verifies both before
// writing, so a sheet edited in the meantime cannot receive another unit's IMEIs.
function openStockDeliveryModal(rowIndex) {
  if (!_stockIsAdmin()) { showAlert('Admin only.', 'e'); return; }
  const idx = parseInt(rowIndex, 10);
  if (!(idx >= 0) || idx >= _stock.rows.length) {
    showAlert('Stock row not found. Refresh the Stock tab and try again.', 'e'); return;
  }
  const r = _stock.rows[idx];
  const h = _stock.headers;
  const mIdx = _colIndex(h, 'Model');
  const sIdx = _colIndex(h, 'Specs');
  const oIdx = _colIndex(h, 'Order Date');
  const model     = mIdx >= 0 ? String(r[mIdx] == null ? '' : r[mIdx]).trim() : '';
  const specs     = sIdx >= 0 ? String(r[sIdx] == null ? '' : r[sIdx]).trim() : '';
  const orderDate = oIdx >= 0 ? String(r[oIdx] == null ? '' : r[oIdx]).trim() : '';

  _stockDeliveryCtx = { rowIndex: idx, orderDate: orderDate, model: model, specs: specs };
  const parts = [model || '(no model)'];
  if (specs) parts.push(specs);
  if (orderDate) parts.push('ordered ' + orderDate);
  $('sd-context').textContent = parts.join(' · ');
  $('sd-date').value = _todayYMD();
  $('sd-imei1').value = '';
  $('sd-imei2').value = '';
  $('stock-delivery-modal').style.display = 'flex';
}

function closeStockDeliveryModal() {
  const m = $('stock-delivery-modal');
  if (m) m.style.display = 'none';
}

async function submitStockDelivery() {
  if (!_stockIsAdmin()) { showAlert('Admin only.', 'e'); return; }
  if (!_stockDeliveryCtx) { showAlert('Open this from an Undelivered row.', 'e'); return; }
  const deliveryDate = v('sd-date');
  const imei1        = v('sd-imei1');
  const imei2        = v('sd-imei2');
  if (!deliveryDate) { showAlert('Delivery Date is required.', 'e'); return; }
  if (!imei1)        { showAlert('IMEI_1 is required.', 'e'); return; }

  const btn = $('sd-submit');
  if (btn) btn.disabled = true;
  showLoader();
  try {
    const res = await gasPost({
      action: 'markStockDelivered',
      rowIndex: _stockDeliveryCtx.rowIndex,
      orderDate: _stockDeliveryCtx.orderDate,
      model: _stockDeliveryCtx.model,
      specs: _stockDeliveryCtx.specs,
      deliveryDate, imei1, imei2,
    });
    if (!res || !res.ok) {
      showAlert('Could not mark delivered: ' + ((res && res.error) || 'Unknown error'), 'e');
      return;
    }
    closeStockDeliveryModal();
    showAlert('Marked delivered.', 's');
    _refreshStockAfterWrite(res.stock);
  } catch (err) {
    showAlert('Could not mark delivered: ' + err.message, 'e');
  } finally {
    hideLoader();
    if (btn) btn.disabled = false;
  }
}

// ── Stage 3: mark an available unit sold ────────────────────────────────────
// IMEI_1 is the key: the Available view only shows units that have one, and the
// server refuses a row whose Selling Date is already filled.
function openStockSellModal(rowIndex) {
  if (!_stockIsAdmin()) { showAlert('Admin only.', 'e'); return; }
  const idx = parseInt(rowIndex, 10);
  if (!(idx >= 0) || idx >= _stock.rows.length) {
    showAlert('Stock row not found. Refresh the Stock tab and try again.', 'e'); return;
  }
  const r = _stock.rows[idx];
  const h = _stock.headers;
  const i1Idx = _colIndex(h, 'IMEI_1');
  const i2Idx = _colIndex(h, 'IMEI_2');
  const mIdx  = _colIndex(h, 'Model');
  const sIdx  = _colIndex(h, 'Specs');
  const imei1 = i1Idx >= 0 ? String(r[i1Idx] == null ? '' : r[i1Idx]).trim() : '';
  if (!imei1) { showAlert('This row has no IMEI_1.', 'e'); return; }

  _stockSellCtx = { imei1: imei1 };
  const model = mIdx >= 0 ? String(r[mIdx] == null ? '' : r[mIdx]).trim() : '';
  const specs = sIdx >= 0 ? String(r[sIdx] == null ? '' : r[sIdx]).trim() : '';
  const parts = [];
  if (model) parts.push(model);
  if (specs) parts.push(specs);
  parts.push('IMEI ' + imei1);
  if (i2Idx >= 0 && r[i2Idx] != null && String(r[i2Idx]).trim()) parts.push('IMEI_2 ' + String(r[i2Idx]).trim());
  $('ss-context').textContent = parts.join(' · ');
  $('ss-price').value = '';
  $('ss-date').value = _todayYMD();
  $('ss-customer').value = '';
  $('ss-payment').value = '';
  $('ss-billing').value = '';
  $('stock-sell-modal').style.display = 'flex';
}

function closeStockSellModal() {
  const m = $('stock-sell-modal');
  if (m) m.style.display = 'none';
}

async function submitStockSold() {
  if (!_stockIsAdmin()) { showAlert('Admin only.', 'e'); return; }
  if (!_stockSellCtx) { showAlert('Open this from an Available row.', 'e'); return; }
  const priceRaw     = v('ss-price');
  const sellingDate  = v('ss-date');
  const customerName = v('ss-customer');
  const paymentMode  = v('ss-payment');
  const billingDate  = v('ss-billing');
  const price        = parseFloat(priceRaw);

  if (priceRaw === '' || isNaN(price)) { showAlert('Selling Price must be a number.', 'e'); return; }
  if (!sellingDate)  { showAlert('Selling Date is required.', 'e'); return; }
  if (!customerName) { showAlert('Customer Name is required.', 'e'); return; }
  if (!paymentMode)  { showAlert('Payment Mode is required.', 'e'); return; }

  const btn = $('ss-submit');
  if (btn) btn.disabled = true;
  showLoader();
  try {
    const res = await gasPost({
      action: 'markStockSold',
      imei1: _stockSellCtx.imei1,
      sellingPrice: price,
      sellingDate,
      customerName,
      paymentMode,
      billingDate,
    });
    if (!res || !res.ok) {
      showAlert('Could not mark sold: ' + ((res && res.error) || 'Unknown error'), 'e');
      return;
    }
    closeStockSellModal();
    showAlert('Marked sold.', 's');
    _refreshStockAfterWrite(res.stock);
  } catch (err) {
    showAlert('Could not mark sold: ' + err.message, 'e');
  } finally {
    hideLoader();
    if (btn) btn.disabled = false;
  }
}

// ── Manual activation check (Stock tab) ─────────────────────────────────────
// The batch checker (js/activation.js) asks the local server to visit every IMEI
// and returns a CSV. This per-row path is deliberately manual: copy IMEI_1, open
// the brand's own activation page, solve the captcha there, then log the date it
// reports. That date is written to the Stock sheet's "Activation date" column.
// Brand -> activation page. Brand names come from the Stock sheet, so matching
// is case/spacing-insensitive. Short aliases such as "mi" only match the whole
// brand name, so they cannot swallow unrelated brands like "Micromax".
const _STOCK_ACTIVATION_SITES = [
  { names: ['nothing'], url: 'https://in.nothing.tech/pages/imei' },
  { names: ['oppo'], url: 'https://support.oppo.com/in/check/' },
  { names: ['iqoo'], url: 'https://www.iqoo.com/in/support/IMEI' },
  { names: ['vivo'], url: 'https://www.vivo.com/en/support/IMEI' },
  { names: ['motorola', 'moto'], url: 'https://en-in.support.motorola.com/app/warranty/check' },
  { names: ['xiaomi', 'redmi', 'mi'], url: 'https://www.mi.com/global/verify/#/en/tab/imei' },
  { names: ['realme'], url: 'https://www.realme.com/in/support/phonecheck' },
  { names: ['oneplus'], url: 'https://service.oneplus.com/in/check#/' },
];

let _stockActivationCtx = null;

function _stockActivationUrl(brand) {
  const b = String(brand == null ? '' : brand).toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!b) return '';
  // Exact brand first, so a short alias cannot match inside another brand.
  for (let i = 0; i < _STOCK_ACTIVATION_SITES.length; i++) {
    const site = _STOCK_ACTIVATION_SITES[i];
    for (let j = 0; j < site.names.length; j++) {
      if (b === site.names[j]) return site.url;
    }
  }
  // Longer names may appear inside a combined label such as "Xiaomi Redmi".
  for (let i = 0; i < _STOCK_ACTIVATION_SITES.length; i++) {
    const site = _STOCK_ACTIVATION_SITES[i];
    for (let j = 0; j < site.names.length; j++) {
      if (site.names[j].length >= 3 && b.indexOf(site.names[j]) !== -1) return site.url;
    }
  }
  return '';
}

// Clipboard writes have to start inside the click handler; window.open moves
// focus to the new tab, so do both synchronously.
function _stockCopyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => _stockCopyFallback(text));
      return true;
    }
  } catch (e) { /* fall through to the textarea copy */ }
  return _stockCopyFallback(text);
}

function _stockCopyFallback(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) {
    return false;
  }
}

// 'Activation date' is the current header; 'Settled' was its old name.
function _stockActivationDateIndex(headers) {
  const i = _colIndex(headers, 'Activation date');
  return i >= 0 ? i : _colIndex(headers, 'Settled');
}

// A cell may hold a placeholder such as NA / N/A / - after a check that found
// nothing. Only a real date should tint the row or turn "Add date" into
// "Edit date".
function _stockHasActivationDate(value) {
  const s = String(value == null ? '' : value).trim();
  return !!s && !/^(n\/?a|nil|none|-|—)$/i.test(s);
}

function _stockRowCtx(rowIndex) {
  const idx = parseInt(rowIndex, 10);
  if (!(idx >= 0) || idx >= _stock.rows.length) return null;
  const r = _stock.rows[idx];
  const h = _stock.headers;
  const text = i => (i >= 0 && r[i] != null) ? String(r[i]).trim() : '';
  return {
    idx: idx,
    row: r,
    imei1: text(_colIndex(h, 'IMEI_1')),
    brand: text(_colIndex(h, 'Brand')),
    model: text(_colIndex(h, 'Model')),
    specs: text(_colIndex(h, 'Specs')),
  };
}

function openStockActivationCheck(rowIndex) {
  const c = _stockRowCtx(rowIndex);
  if (!c) { showAlert('Stock row not found. Refresh the Stock tab and try again.', 'e'); return; }
  if (!c.imei1) { showAlert('This row has no IMEI_1.', 'e'); return; }

  const url = _stockActivationUrl(c.brand);
  const copied = _stockCopyText(c.imei1);
  if (!url) {
    showAlert('No activation page saved for ' + _esc(c.brand || 'this brand') + ' yet. IMEI '
      + _esc(c.imei1) + ' was copied.', 'w');
    return;
  }
  // Open synchronously so the browser treats it as part of the click.
  const win = window.open(url, '_blank');
  if (win) { try { win.opener = null; } catch (e) {} }
  if (copied) {
    showAlert('IMEI ' + _esc(c.imei1) + ' copied. Paste it on the ' + _esc(c.brand)
      + ' page, then solve the captcha.', 's');
  } else {
    showAlert('Could not copy automatically. IMEI: ' + _esc(c.imei1), 'w');
  }
}

function _stockYMD(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

function openStockActivationDateModal(rowIndex) {
  if (!_stockIsAdmin()) { showAlert('Admin only.', 'e'); return; }
  const c = _stockRowCtx(rowIndex);
  if (!c) { showAlert('Stock row not found. Refresh the Stock tab and try again.', 'e'); return; }
  if (!c.imei1) { showAlert('This row has no IMEI_1.', 'e'); return; }
  const aIdx = _stockActivationDateIndex(_stock.headers);
  if (aIdx < 0) {
    showAlert('The Stock sheet has no "Activation date" column.', 'e');
    return;
  }

  _stockActivationCtx = { imei1: c.imei1 };
  const parts = [];
  if (c.model) parts.push(c.model);
  if (c.specs) parts.push(c.specs);
  parts.push('IMEI ' + c.imei1);
  $('sa-context').textContent = parts.join(' · ');

  const existing = parseSheetDate(c.row[aIdx]);
  $('sa-date').value = existing ? _stockYMD(existing) : _todayYMD();
  $('stock-activation-modal').style.display = 'flex';
  const inp = $('sa-date');
  if (inp && inp.focus) setTimeout(() => inp.focus(), 50);
}

function closeStockActivationDateModal() {
  const m = $('stock-activation-modal');
  if (m) m.style.display = 'none';
}

async function submitStockActivationDate() {
  if (!_stockIsAdmin()) { showAlert('Admin only.', 'e'); return; }
  if (!_stockActivationCtx) { showAlert('Open this from an Available row.', 'e'); return; }
  const activationDate = v('sa-date');
  if (!activationDate) { showAlert('Activation Date is required.', 'e'); return; }

  const btn = $('sa-submit');
  if (btn) btn.disabled = true;
  showLoader();
  try {
    const res = await gasPost({
      action: 'markStockActivation',
      imei1: _stockActivationCtx.imei1,
      activationDate,
    });
    if (!res || !res.ok) {
      const msg = (res && res.error) || 'Unknown error';
      if (/unknown action:\s*markStockActivation/i.test(msg)) {
        showAlert('The Apps Script deployment is still the old version, so it does not know markStockActivation yet. '
          + 'Open the Apps Script project, paste the latest google-apps-script-separate-sheets.js, then '
          + 'Deploy → Manage deployments → Edit → Version: New version → Deploy. '
          + 'Edit the existing deployment (do not create a new one) so the URL stays the same.', 'e');
      } else {
        showAlert('Could not save the activation date: ' + msg, 'e');
      }
      return;
    }
    closeStockActivationDateModal();
    showAlert('Activation date saved.', 's');
    _refreshStockAfterWrite(res.stock);
  } catch (err) {
    showAlert('Could not save the activation date: ' + err.message, 'e');
  } finally {
    hideLoader();
    if (btn) btn.disabled = false;
  }
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _jsStr(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function _stockAmt(n) {
  if (n == null || n === '') return '—';
  const v = Number(n);
  return isNaN(v) ? '—' : '₹' + Math.round(v).toLocaleString('en-IN');
}

function _stockCell(c, header) {
  if (c == null || c === '') return '';
  const h = (header || '').toLowerCase();
  if (_STOCK_AMT_COLS.indexOf(h) !== -1) {
    const n = parseFloat(c);
    return isNaN(n) ? _esc(c) : _stockAmt(n);
  }
  return _esc(c);
}

function _colIndex(headers, name) {
  return headers.findIndex(h => String(h || '').toLowerCase() === name.toLowerCase());
}

// 'Paid By' was formerly 'Payment Mode'; accept either header name.
function _paidByCol(headers) {
  let i = _colIndex(headers, 'Paid By');
  if (i !== -1) return i;
  return _colIndex(headers, 'Payment Mode');
}

function parseMonthYy(s) {
  const m = String(s || '').trim().match(/^(\w{3})\s*(\d{2,4})$/);
  if (!m) return null;
  const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  const mo = months[m[1].toLowerCase()];
  if (mo === undefined) return null;
  let yr = parseInt(m[2]);
  if (yr < 100) yr += yr < 50 ? 2000 : 1900;
  return new Date(yr, mo, 1);
}

function _sortVal(c, header) {
  const h = (header || '').toLowerCase();
  if (_STOCK_AMT_COLS.indexOf(h) !== -1) {
    const n = parseFloat(c);
    return isNaN(n) ? 0 : n;
  }
  if (h === 'month sold') { const d = parseMonthYy(c); return d ? d.getTime() : 0; }
  if (h.indexOf('date') !== -1) { const d = parseSheetDate(c); return d ? d.getTime() : 0; }
  return String(c == null ? '' : c).toLowerCase();
}

function _sumCost(rows, costIdx) {
  let s = 0;
  rows.forEach(r => {
    const n = parseFloat(r[costIdx]);
    if (!isNaN(n)) s += n;
  });
  return s;
}

function toggleStockDevice(dev) {
  _stockCollapsedD[dev] = !_stockCollapsedD[dev];
  renderStock();
}

function toggleStockBrand(dev, brand) {
  const key = dev + '||' + brand;
  _stockCollapsedB[key] = !_stockCollapsedB[key];
  renderStock();
}

function toggleStockModel(dev, brand, model) {
  const key = dev + '||' + brand + '||' + model;
  _stockCollapsedMod[key] = !_stockCollapsedMod[key];
  renderStock();
}

function toggleStockSpec(dev, brand, model, spec) {
  const key = dev + '||' + brand + '||' + model + '||' + spec;
  _stockCollapsedSpec[key] = !_stockCollapsedSpec[key];
  renderStock();
}

function toggleStockUModel(model) {
  _stockCollapsedUM[model] = !_stockCollapsedUM[model];
  renderStock();
}

function toggleStockUSpec(model, spec) {
  const key = model + '||' + spec;
  _stockCollapsedUS[key] = !_stockCollapsedUS[key];
  renderStock();
}

function toggleStockMonth(month) {
  _stockCollapsedM[month] = !_stockCollapsedM[month];
  renderStock();
}

function toggleStockAllDevices() {
  const sets =
    _stockFilter === 'available' ? [ [ _stockCollapsedD, _stockDeviceNames ], [ _stockCollapsedB, _stockBrandKeys ],
                                     [ _stockCollapsedMod, _stockModelKeys ], [ _stockCollapsedSpec, _stockSpecKeys ] ]
  : _stockFilter === 'undelivered' ? [ [ _stockCollapsedUM, _stockUModelKeys ], [ _stockCollapsedUS, _stockUSpecKeys ] ]
  : _stockFilter === 'sold' ? [ [ _stockCollapsedM, _stockMonthKeys ] ]
  : [];
  let any = false;
  sets.forEach(([store, keys]) => keys.forEach(k => { if (store[k]) any = true; }));
  sets.forEach(([store, keys]) => keys.forEach(k => { store[k] = !any; }));
  renderStock();
}

function _toggleCell(label, cls, onclickExpr, collapsed, count) {
  const chev = collapsed ? '▶' : '▼';
  const suffix = (count === undefined || count === null) ? '' : ' (' + count + ')';
  return '<td class="' + cls + '" onclick="' + onclickExpr + '">'
    + '<span class="st-chev">' + chev + '</span> ' + _esc(String(label) + suffix) + '</td>';
}

// Available view: Device > Brand > Model > Specs, each level a collapsing
// group carrying its own unit count. Rows are walked in sheet order, so the
// data has to be sorted Device, Brand, Model, Specs — which renderStock does.
function buildAvailableRows(data, headers) {
  const dIdx = _colIndex(headers, 'Device');
  const bIdx = _colIndex(headers, 'Brand');
  const mIdx = _colIndex(headers, 'Model');
  const sIdx = _colIndex(headers, 'Specs');
  const iIdx = _colIndex(headers, 'IMEI_1');
  const i2Idx = _colIndex(headers, 'IMEI_2');
  const aIdx = _stockActivationDateIndex(headers);
  const cIdx = _colIndex(headers, 'Cost Price');
  const blank = '<td></td>';
  const searching = _stockSearchActive;
  // Action column exists only for admins. Every collapsed/group row leaves it
  // blank; only a real unit (a leaf row) gets Check / Add date / Sell buttons.
  const actBlank = _stockCanEdit ? '<td class="st-action-cell"></td>' : '';
  const actCell = r => {
    if (!_stockCanEdit) return '';
    const idx = _stockRowMap.has(r) ? _stockRowMap.get(r) : -1;
    const hasDate = aIdx >= 0 && _stockHasActivationDate(r[aIdx]);
    return '<td class="st-action-cell"><div class="st-action-stack">'
      + '<button class="btn btn-sm" title="Copy IMEI_1 and open this brand\'s activation page"'
      + ' onclick="openStockActivationCheck(' + idx + ')">Check</button>'
      + '<button class="btn btn-sm" title="' + (hasDate ? 'Edit' : 'Add') + ' the activation date"'
      + ' onclick="openStockActivationDateModal(' + idx + ')">' + (hasDate ? 'Edit date' : 'Add date') + '</button>'
      + '<button class="btn btn-sm" onclick="openStockSellModal(' + idx + ')">Sell</button>'
      + '</div></td>';
  };

  const cell = (v, i, empty) => String(v[i] == null ? '' : v[i]).trim() || empty;

  const devices = [];
  data.forEach(r => {
    const d = cell(r, dIdx, '(no device)');
    const b = cell(r, bIdx, '(no brand)');
    const m = cell(r, mIdx, '(no model)');
    const s = cell(r, sIdx, '(no specs)');

    let devG = devices.length ? devices[devices.length - 1] : null;
    if (!devG || devG.dev !== d) { devG = { dev: d, brands: [] }; devices.push(devG); }
    let brG = devG.brands.length ? devG.brands[devG.brands.length - 1] : null;
    if (!brG || brG.brand !== b) { brG = { brand: b, models: [] }; devG.brands.push(brG); }
    let moG = brG.models.length ? brG.models[brG.models.length - 1] : null;
    if (!moG || moG.model !== m) { moG = { model: m, specs: [] }; brG.models.push(moG); }
    let spG = moG.specs.length ? moG.specs[moG.specs.length - 1] : null;
    if (!spG || spG.spec !== s) { spG = { spec: s, rows: [] }; moG.specs.push(spG); }
    spG.rows.push(r);
  });

  const count = g => g.rows ? g.rows.length
    : g.specs ? g.specs.reduce((a, x) => a + x.rows.length, 0)
    : g.models ? g.models.reduce((a, x) => a + count(x), 0)
    : g.brands.reduce((a, x) => a + count(x), 0);
  // Every leaf row underneath a group, however deep it is nested.
  const allRows = g => g.rows ? g.rows
    : g.specs ? g.specs.reduce((a, x) => a.concat(allRows(x)), [])
    : g.models ? g.models.reduce((a, x) => a.concat(allRows(x)), [])
    : g.brands.reduce((a, x) => a.concat(allRows(x)), []);

  _stockDeviceNames  = devices.map(g => g.dev);
  _stockBrandKeys    = [];
  _stockModelKeys    = [];
  _stockSpecKeys     = [];
  devices.forEach(dG => dG.brands.forEach(bG => {
    _stockBrandKeys.push(dG.dev + '||' + bG.brand);
    bG.models.forEach(mG => {
      _stockModelKeys.push(dG.dev + '||' + bG.brand + '||' + mG.model);
      mG.specs.forEach(sG => _stockSpecKeys.push(dG.dev + '||' + bG.brand + '||' + mG.model + '||' + sG.spec));
    });
  }));

  const devCell   = (d, collapsed, n) => _toggleCell(d, 'st-dev-cell',
    "toggleStockDevice('" + _jsStr(d) + "')", collapsed, n);
  const brandCell = (b, d, collapsed, n) => _toggleCell(b, 'st-brand-cell',
    "toggleStockBrand('" + _jsStr(d) + "','" + _jsStr(b) + "')", collapsed, n);
  const modelCell = (m, d, b, collapsed, n) => _toggleCell(m, 'st-model-cell',
    "toggleStockModel('" + _jsStr(d) + "','" + _jsStr(b) + "','" + _jsStr(m) + "')", collapsed, n);
  const specCell  = (s, d, b, m, collapsed, n) => _toggleCell(s, 'st-spec-cell',
    "toggleStockSpec('" + _jsStr(d) + "','" + _jsStr(b) + "','" + _jsStr(m) + "','" + _jsStr(s) + "')", collapsed, n);

  const html = [];
  devices.forEach(devG => {
    const d = devG.dev;
    const devN = count(devG);
    if (!searching && _stockCollapsedD[d]) {
      html.push('<tr>' + devCell(d, true, devN) + blank + blank + blank + blank + blank + blank + '<td>'
        + _stockAmt(_sumCost(allRows(devG), cIdx)) + '</td>' + actBlank + '</tr>');
      return;
    }
    // Each level emits its own cell exactly once — on the first row it shows.
    let devDone = false;
    const takeDev = () => { if (devDone) return blank; devDone = true; return devCell(d, false, devN); };

    devG.brands.forEach(brG => {
      const b = brG.brand, bKey = d + '||' + b, bN = count(brG);
      if (!searching && _stockCollapsedB[bKey]) {
        html.push('<tr>' + takeDev() + brandCell(b, d, true, bN)
          + blank + blank + blank + blank + blank + '<td>' + _stockAmt(_sumCost(allRows(brG), cIdx)) + '</td>' + actBlank + '</tr>');
        devDone = true;
        return;
      }
      let brandDone = false;
      const takeBrand = () => { if (brandDone) return blank; brandDone = true; return brandCell(b, d, false, bN); };

      brG.models.forEach(moG => {
        const m = moG.model, mKey = bKey + '||' + m, mN = count(moG);
        if (!searching && _stockCollapsedMod[mKey]) {
          html.push('<tr>' + takeDev() + takeBrand() + modelCell(m, d, b, true, mN)
            + blank + blank + blank + blank + '<td>' + _stockAmt(_sumCost(allRows(moG), cIdx)) + '</td>' + actBlank + '</tr>');
          devDone = brandDone = true;
          return;
        }
        let modelDone = false;
        const takeModel = () => { if (modelDone) return blank; modelDone = true; return modelCell(m, d, b, false, mN); };

        moG.specs.forEach(spG => {
          const s = spG.spec, sKey = mKey + '||' + s, sN = spG.rows.length;
          const lead = takeDev() + takeBrand() + takeModel();
          if (!searching && _stockCollapsedSpec[sKey]) {
            html.push('<tr>' + lead + specCell(s, d, b, m, true, sN)
              + blank + blank + blank + '<td>' + _stockAmt(_sumCost(spG.rows, cIdx)) + '</td>' + actBlank + '</tr>');
            devDone = brandDone = modelDone = true;
            return;
          }
          const specHtml = specCell(s, d, b, m, false, sN);
          // The group cells belong on the FIRST row of the group only; every
          // row after it gets blanks, or the name repeats down the column.
          const leadFirst = lead + specHtml;
          const leadRest = blank + blank + blank + blank;
          const leaf = spG.rows.map((r, ri) => {
            const actDate = aIdx >= 0 && _stockHasActivationDate(r[aIdx]);
            return '<tr' + (actDate ? ' class="st-activation-row"' : '') + '>' + (ri === 0 ? leadFirst : leadRest)
              + '<td>' + _stockCell(r[iIdx], 'IMEI_1') + '</td>'
              + '<td>' + _stockCell(r[i2Idx], 'IMEI_2') + '</td>'
              + '<td>' + _stockCell(r[aIdx], 'Activation Date') + '</td>'
              + '<td>' + _stockCell(r[cIdx], 'Cost Price') + '</td>'
              + actCell(r) + '</tr>';
          });
          devDone = brandDone = modelDone = true;
          html.push(leaf.join(''));
        });
      });
    });
  });
  return html.join('');
}

// Sold view: flat rows grouped by Month Sold; collapsed rows sum Kunal Telecom + AKS Share
function buildSoldRows(data, headers) {
  const order = ['Month Sold','Selling Date','Model','Specs','Customer Name','Payment Mode','IMEI_1','Cost Price','Selling Price','Kunal Telecom','AKS Share'];
  const idx = order.map(n => _colIndex(headers, n));
  const mIdx = idx[0];
  const ktIdx = _colIndex(headers, 'Kunal Telecom');
  const aksIdx = _colIndex(headers, 'AKS Share');
  // Named, not numbered: inserting Specification shifts every position after it,
  // and a hard-coded 6 would silently start summing the wrong column.
  const iCost = order.indexOf('Cost Price');
  const iSell = order.indexOf('Selling Price');
  const iKt   = order.indexOf('Kunal Telecom');
  const iAks  = order.indexOf('AKS Share');

  const months = [];
  data.forEach(r => {
    const m = String(r[mIdx] == null ? '' : r[mIdx]).trim() || '(no month)';
    if (months.length && months[months.length - 1].month === m) months[months.length - 1].rows.push(r);
    else months.push({ month: m, rows: [r] });
  });
  _stockMonthKeys = months.map(g => g.month);

  const html = [];
  months.forEach(mg => {
    const m = mg.month;
    const collapsed = !_stockSearchActive && !!_stockCollapsedM[m];
    const monthCell = _toggleCell(m, 'st-month-cell',
      "toggleStockMonth('" + _jsStr(m) + "')", collapsed, mg.rows.length);

    if (collapsed) {
      const cells = idx.map((ci, i) => {
        if (i === 0) return monthCell;
        if (i === iCost) return '<td>' + _stockAmt(_sumCost(mg.rows, ci)) + '</td>';
        if (i === iSell) return '<td>' + _stockAmt(_sumCost(mg.rows, ci)) + '</td>';
        if (i === iKt)   return '<td>' + _stockAmt(_sumCost(mg.rows, ktIdx)) + '</td>';
        if (i === iAks)  return '<td>' + _stockAmt(_sumCost(mg.rows, aksIdx)) + '</td>';
        return '<td></td>';
      });
      html.push('<tr>' + cells.join('') + '</tr>');
      return;
    }
    mg.rows.forEach((r, ri) => {
      const cells = idx.map((ci, i) => {
        if (i === 0) return ri === 0 ? monthCell : '<td></td>';
        return '<td>' + _stockCell(r[ci], order[i]) + '</td>';
      });
      html.push('<tr>' + cells.join('') + '</tr>');
    });
  });
  return html.join('');
}

// Cost Sheet: one row per Device + Model + Specs holding the HIGHEST cost
// seen, for units carrying BOTH an order date and a selling date. The dearest
// price is the one you quote from; an average would hide the outlier.
function buildCostSheet(rows, headers) {
  const iOf = n => n === 'Paid By' ? _paidByCol(headers) : _colIndex(headers, n);
  const dIdx = iOf('Device'), mIdx = iOf('Model'), sIdx = iOf('Specs'), cIdx = iOf('Cost Price');
  const oIdx = iOf('Order Date'), vIdx = iOf('Selling Date');
  const has = (r, i) => i >= 0 && r[i] != null && String(r[i]).trim() !== '';
  const text = (r, i, empty) => String(r[i] == null ? '' : r[i]).trim() || empty;

  const out = [];
  const byKey = {};
  rows.forEach(r => {
    if (!has(r, oIdx) || !has(r, vIdx)) return;
    const d = text(r, dIdx, '(no device)');
    const m = text(r, mIdx, '(no model)');
    const s = text(r, sIdx, '(no specs)');
    const key = d + '\u0001' + m + '\u0001' + s;
    const n = parseFloat(r[cIdx]);
    let row = byKey[key];
    if (!row) {
      row = [d, m, s, isNaN(n) ? null : n];
      byKey[key] = row;
      out.push(row);
    } else if (!isNaN(n) && (row[3] === null || n > row[3])) {
      row[3] = n;
    }
  });
  return out.sort((a, b) =>
    a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));
}

// Undelivered: Model > Specs. Each level collapses to its name, its unit count
// and the summed Cost Price underneath it — same shape as the Available tree,
// one level shallower and with Order Date / Marketplace / Paid By as data.
function buildUndeliveredRows(data, headers) {
  const iOf = n => n === 'Paid By' ? _paidByCol(headers) : _colIndex(headers, n);
  const mIdx = iOf('Model'), sIdx = iOf('Specs'), cIdx = iOf('Cost Price');
  const oIdx = iOf('Order Date'), pIdx = iOf('Marketplace'), payIdx = _paidByCol(headers);
  const blank = '<td></td>';
  // Action column exists only for admins; only a leaf unit gets a Deliver button.
  const actBlank = _stockCanEdit ? '<td class="st-action-cell"></td>' : '';
  const actDeliver = r => {
    if (!_stockCanEdit) return '';
    const idx = _stockRowMap.has(r) ? _stockRowMap.get(r) : -1;
    return '<td class="st-action-cell"><button class="btn btn-sm" onclick="openStockDeliveryModal(' + idx + ')">Deliver</button></td>';
  };
  const text = (r, i, empty) => String(r[i] == null ? '' : r[i]).trim() || empty;

  const groups = [];
  data.forEach(r => {
    const m = text(r, mIdx, '(no model)');
    const s = text(r, sIdx, '(no specs)');
    let mg = groups.length ? groups[groups.length - 1] : null;
    if (!mg || mg.model !== m) { mg = { model: m, specs: [] }; groups.push(mg); }
    let sg = mg.specs.length ? mg.specs[mg.specs.length - 1] : null;
    if (!sg || sg.spec !== s) { sg = { spec: s, rows: [] }; mg.specs.push(sg); }
    sg.rows.push(r);
  });

  _stockUModelKeys = groups.map(g => g.model);
  _stockUSpecKeys = [];
  groups.forEach(g => g.specs.forEach(sg => _stockUSpecKeys.push(g.model + '||' + sg.spec)));

  const modelCell = (m, collapsed, n) => _toggleCell(m, 'st-model-cell',
    "toggleStockUModel('" + _jsStr(m) + "')", collapsed, n);
  const specCell = (s, m, collapsed, n) => _toggleCell(s, 'st-spec-cell',
    "toggleStockUSpec('" + _jsStr(m) + "','" + _jsStr(s) + "')", collapsed, n);
  const sum = rows => _stockAmt(_sumCost(rows, cIdx));
  const count = g => g.rows ? g.rows.length : g.specs.reduce((a, x) => a + x.rows.length, 0);

  const html = [];
  groups.forEach(mg => {
    const m = mg.model, mN = count(mg);
    if (!_stockSearchActive && _stockCollapsedUM[m]) {
      html.push('<tr>' + modelCell(m, true, mN) + blank + blank + blank + blank
        + '<td>' + sum(mg.specs.reduce((a, sg) => a.concat(sg.rows), [])) + '</td>' + actBlank + '</tr>');
      return;
    }
    let mDone = false;
    const takeModel = () => { if (mDone) return blank; mDone = true; return modelCell(m, false, mN); };
    mg.specs.forEach(sg => {
      const s = sg.spec, sKey = m + '||' + s, sN = sg.rows.length;
      const lead = takeModel();
      if (!_stockSearchActive && _stockCollapsedUS[sKey]) {
        html.push('<tr>' + lead + specCell(s, m, true, sN) + blank + blank + blank
          + '<td>' + sum(sg.rows) + '</td>' + actBlank + '</tr>');
        mDone = true;
        return;
      }
      const specHtml = specCell(s, m, false, sN);
      // The group cells belong on the FIRST row of the group only.
      const first = lead + specHtml, rest = blank + blank;
      const leaf = sg.rows.map((r, ri) => '<tr>' + (ri === 0 ? first : rest)
        + '<td>' + _stockCell(r[oIdx], 'Order Date') + '</td>'
        + '<td>' + _stockCell(r[pIdx], 'Marketplace') + '</td>'
        + '<td>' + _stockCell(r[payIdx], 'Paid By') + '</td>'
        + '<td>' + _stockCell(r[cIdx], 'Cost Price') + '</td>'
        + actDeliver(r) + '</tr>');
      mDone = true;
      html.push(leaf.join(''));
    });
  });
  return html.join('');
}

// One definition of "in stock": the unit has an IMEI and has not been sold.
// Column indexes are resolved once, not per row.
function _availFilter(headers) {
  const iIdx = _colIndex(headers, 'IMEI_1');
  const sIdx = _colIndex(headers, 'Selling Date');
  return r => {
    const hasImei = iIdx >= 0 && r[iIdx] != null && String(r[iIdx]).trim() !== '';
    const sold    = sIdx >= 0 && r[sIdx] != null && String(r[sIdx]).trim() !== '';
    return hasImei && !sold;
  };
}

function renderStock() {
  const el = $('stock-results');
  if (!el) return;
  _stockCanEdit = _stockIsAdmin();
  _syncStockFab();
  const { headers, rows } = _stock;
  if (!headers.length) { el.innerHTML = '<div class="empty">No stock data found.</div>'; return; }

  // Row object -> index in the sheet-backed array. Stage 2 needs the exact row
  // because an undelivered unit has no IMEI to identify it by yet.
  _stockRowMap = new Map();
  rows.forEach((r, i) => _stockRowMap.set(r, i));

  // IMEI search: match the query against IMEI_1 or IMEI_2 on every pill.
  const q = (($('stock-search') ? $('stock-search').value : '') || '').trim().toLowerCase();
  _stockSearchActive = !!q;
  const i1Idx = _colIndex(headers, 'IMEI_1');
  const i2Idx = _colIndex(headers, 'IMEI_2');
  const searchRows = q ? rows.filter(r => {
    const i1 = i1Idx >= 0 ? String(r[i1Idx] == null ? '' : r[i1Idx]) : '';
    const i2 = i2Idx >= 0 ? String(r[i2Idx] == null ? '' : r[i2Idx]) : '';
    return i1.toLowerCase().includes(q) || i2.toLowerCase().includes(q);
  }) : rows;

  let cols = headers;
  let data = searchRows;
  let grouped = false;

  if (_STOCK_FILTERS.indexOf(_stockFilter) !== -1) {
    const cfg = _STOCK_DISPLAY[_stockFilter];
    cols = cfg.cols;
    if (_stockFilter === 'costsheet') {
      // Flat roll-up: filter + collapse happen inside the builder.
      data = buildCostSheet(searchRows, headers);
    } else {
      const idx = cols.map(n => n === 'Paid By' ? _paidByCol(headers) : _colIndex(headers, n));
      const sIdx = _colIndex(headers, 'Selling Date');
      const oIdx = _colIndex(headers, 'Order Date');
      const dIdx = _colIndex(headers, 'Delivery Date');
      const isSold = r => sIdx >= 0 && r[sIdx] != null && String(r[sIdx]).trim() !== '';
      const isUndelivered = r => {
        const hasOrder = oIdx >= 0 && r[oIdx] != null && String(r[oIdx]).trim() !== '';
        const hasDelivery = dIdx >= 0 && r[dIdx] != null && String(r[dIdx]).trim() !== '';
        return hasOrder && !hasDelivery;
      };
      if (_stockFilter === 'available') data = searchRows.filter(_availFilter(headers));
      else if (_stockFilter === 'sold') data = searchRows.filter(r => isSold(r));
      else data = searchRows.filter(isUndelivered);
      const descSet = _STOCK_SORT_DESC[_stockFilter] || {};
      data = data.slice().sort((a, b) => {
        for (let i = 0; i < idx.length; i++) {
          const ci = idx[i];
          const desc = !!descSet[cols[i]];
          const va = _sortVal(a[ci], headers[ci]);
          const vb = _sortVal(b[ci], headers[ci]);
          if (va < vb) return desc ? 1 : -1;
          if (va > vb) return desc ? -1 : 1;
        }
        return 0;
      });
      grouped = true;
    }
  }

  const tbody = grouped
    ? (_stockFilter === 'available' ? buildAvailableRows(data, headers)
      : _stockFilter === 'undelivered' ? buildUndeliveredRows(data, headers)
      : buildSoldRows(data, headers))
    : data.map(r => '<tr>' + r.map((c, i) => '<td>' + _stockCell(c, cols[i]) + '</td>').join('') + '</tr>').join('');

  let anyCollapsed = false;
  if (grouped) {
    anyCollapsed =
      _stockFilter === 'available'
        ? _stockDeviceNames.some(d => _stockCollapsedD[d]) ||
          _stockBrandKeys.some(k => _stockCollapsedB[k]) ||
          _stockModelKeys.some(k => _stockCollapsedMod[k]) ||
          _stockSpecKeys.some(k => _stockCollapsedSpec[k])
      : _stockFilter === 'undelivered'
        ? _stockUModelKeys.some(k => _stockCollapsedUM[k]) ||
          _stockUSpecKeys.some(k => _stockCollapsedUS[k])
      : _stockMonthKeys.some(k => _stockCollapsedM[k]);
  }
  // Groups are force-expanded while searching, so the collapse toggle would
  // have no visible effect — hide it until the search box is cleared.
  const collapseBtn = (grouped && !_stockSearchActive)
    ? ' <button class="btn btn-sm" onclick="toggleStockAllDevices()" style="margin-left:8px">' + (anyCollapsed ? 'Expand all' : 'Collapse all') + '</button>'
    : '';

  // The Action column is admin-only and exists only on the two pills that carry
  // row buttons. Appended after sorting so it never participates in the sort.
  const showActions = _stockCanEdit &&
    (_stockFilter === 'available' || _stockFilter === 'undelivered');
  const displayCols = showActions ? cols.concat(['Action']) : cols;

  el.innerHTML = `<div style="font-size:12px;color:#888;margin-bottom:0.5rem">${data.length} of ${rows.length} rows${collapseBtn}</div>
    <div style="overflow-x:auto;border:0.5px solid #eee;border-radius:8px">
      <table class="emi-table${_stockFilter === 'sold' ? ' stock-table' : ''}">
        <thead><tr>${displayCols.map(h => {
          const wide = (_stockFilter === 'available' && (h === 'Device' || h === 'Model'))
            ? ' class="stock-wide-' + (h === 'Device' ? 'device' : 'model') + '"' : '';
          return '<th' + wide + '>' + _esc(h) + '</th>';
        }).join('')}</tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
}
