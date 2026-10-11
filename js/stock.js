// ── STOCK ───────────────────────────────────────────────────────────────────
// Admin-only tab: shows stock rows from an external spreadsheet.
// Pills: Available | Cost Sheet | Sold | Undelivered.
// Available view is a four-level tree — Device > Brand > Model > Specs — and
// each level collapses to one row showing its name, its unit count and the
// summed Cost Price of everything under it. Undelivered is two levels —
// Model > Specs. Cost Sheet is a flat roll-up: one row per Device/Model/Specs
// holding the HIGHEST cost seen, for units that have both an order and a
// selling date.

let _stock = { headers: [], rows: [] };
let _stockLoaded = false;
let _stockFilter = 'available';

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
  available:   { cols: ['Device','Brand','Model','Specs','IMEI_1','Cost Price'] },
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
  await loadStock();
}

function setStockFilter(f) {
  _stockFilter = f;
  document.querySelectorAll('#stock-pills .stock-tab').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-f') === f);
  });
  renderStock();
}

async function loadStock() {
  // Every snapshot already carries stock: pushSnapshot() runs readStock with
  // forceRefresh=1, and readStock opens the other spreadsheet itself by ID
  // (SpreadsheetApp.openById(STOCK_SHEET_ID)), so a separate worksheet is no
  // obstacle. Paint it and return — zero network calls.
  if (S.snapStock && S.snapStock.headers) {
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
  const cIdx = _colIndex(headers, 'Cost Price');
  const blank = '<td></td>';

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
    if (_stockCollapsedD[d]) {
      html.push('<tr>' + devCell(d, true, devN) + blank + blank + blank + blank + '<td>'
        + _stockAmt(_sumCost(allRows(devG), cIdx)) + '</td></tr>');
      return;
    }
    // Each level emits its own cell exactly once — on the first row it shows.
    let devDone = false;
    const takeDev = () => { if (devDone) return blank; devDone = true; return devCell(d, false, devN); };

    devG.brands.forEach(brG => {
      const b = brG.brand, bKey = d + '||' + b, bN = count(brG);
      if (_stockCollapsedB[bKey]) {
        html.push('<tr>' + takeDev() + brandCell(b, d, true, bN)
          + blank + blank + blank + '<td>' + _stockAmt(_sumCost(allRows(brG), cIdx)) + '</td></tr>');
        devDone = true;
        return;
      }
      let brandDone = false;
      const takeBrand = () => { if (brandDone) return blank; brandDone = true; return brandCell(b, d, false, bN); };

      brG.models.forEach(moG => {
        const m = moG.model, mKey = bKey + '||' + m, mN = count(moG);
        if (_stockCollapsedMod[mKey]) {
          html.push('<tr>' + takeDev() + takeBrand() + modelCell(m, d, b, true, mN)
            + blank + blank + '<td>' + _stockAmt(_sumCost(allRows(moG), cIdx)) + '</td></tr>');
          devDone = brandDone = true;
          return;
        }
        let modelDone = false;
        const takeModel = () => { if (modelDone) return blank; modelDone = true; return modelCell(m, d, b, false, mN); };

        moG.specs.forEach(spG => {
          const s = spG.spec, sKey = mKey + '||' + s, sN = spG.rows.length;
          const lead = takeDev() + takeBrand() + takeModel();
          if (_stockCollapsedSpec[sKey]) {
            html.push('<tr>' + lead + specCell(s, d, b, m, true, sN)
              + blank + '<td>' + _stockAmt(_sumCost(spG.rows, cIdx)) + '</td></tr>');
            devDone = brandDone = modelDone = true;
            return;
          }
          const specHtml = specCell(s, d, b, m, false, sN);
          // The group cells belong on the FIRST row of the group only; every
          // row after it gets blanks, or the name repeats down the column.
          const leadFirst = lead + specHtml;
          const leadRest = blank + blank + blank + blank;
          const leaf = spG.rows.map((r, ri) => '<tr>' + (ri === 0 ? leadFirst : leadRest)
            + '<td>' + _stockCell(r[iIdx], 'IMEI_1') + '</td>'
            + '<td>' + _stockCell(r[cIdx], 'Cost Price') + '</td></tr>');
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
    const collapsed = !!_stockCollapsedM[m];
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
    if (_stockCollapsedUM[m]) {
      html.push('<tr>' + modelCell(m, true, mN) + blank + blank + blank + blank
        + '<td>' + sum(mg.specs.reduce((a, sg) => a.concat(sg.rows), [])) + '</td></tr>');
      return;
    }
    let mDone = false;
    const takeModel = () => { if (mDone) return blank; mDone = true; return modelCell(m, false, mN); };
    mg.specs.forEach(sg => {
      const s = sg.spec, sKey = m + '||' + s, sN = sg.rows.length;
      const lead = takeModel();
      if (_stockCollapsedUS[sKey]) {
        html.push('<tr>' + lead + specCell(s, m, true, sN) + blank + blank + blank
          + '<td>' + sum(sg.rows) + '</td></tr>');
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
        + '<td>' + _stockCell(r[cIdx], 'Cost Price') + '</td></tr>');
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
  const { headers, rows } = _stock;
  if (!headers.length) { el.innerHTML = '<div class="empty">No stock data found.</div>'; return; }

  let cols = headers;
  let data = rows;
  let grouped = false;

  if (_STOCK_FILTERS.indexOf(_stockFilter) !== -1) {
    const cfg = _STOCK_DISPLAY[_stockFilter];
    cols = cfg.cols;
    if (_stockFilter === 'costsheet') {
      // Flat roll-up: filter + collapse happen inside the builder.
      data = buildCostSheet(rows, headers);
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
      if (_stockFilter === 'available') data = rows.filter(_availFilter(headers));
      else if (_stockFilter === 'sold') data = rows.filter(r => isSold(r));
      else data = rows.filter(isUndelivered);
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
  const collapseBtn = grouped
    ? ' <button class="btn btn-sm" onclick="toggleStockAllDevices()" style="margin-left:8px">' + (anyCollapsed ? 'Expand all' : 'Collapse all') + '</button>'
    : '';

  el.innerHTML = `<div style="font-size:12px;color:#888;margin-bottom:0.5rem">${data.length} of ${rows.length} rows${collapseBtn}</div>
    <div style="overflow-x:auto;border:0.5px solid #eee;border-radius:8px">
      <table class="emi-table${_stockFilter === 'sold' ? ' stock-table' : ''}">
        <thead><tr>${cols.map(h => {
          const wide = (_stockFilter === 'available' && (h === 'Device' || h === 'Model'))
            ? ' class="stock-wide-' + (h === 'Device' ? 'device' : 'model') + '"' : '';
          return '<th' + wide + '>' + _esc(h) + '</th>';
        }).join('')}</tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
}
