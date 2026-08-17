// ── STOCK ───────────────────────────────────────────────────────────────────
// Admin-only tab: shows stock rows from an external spreadsheet.
// Pills: Available (not yet sold) | Sold | Undelivered.
// Available view: flat rows; each Device group collapses into a single row
// showing the Device name and summed Cost Price.

let _stock = { headers: [], rows: [] };
let _stockLoaded = false;
let _stockFilter = 'available';

// device name -> true when that Device group is collapsed (Available view)
let _stockCollapsedD = {};
let _stockCollapsedB = {}; // 'Device||Brand' -> true when that Brand group is collapsed
let _stockCollapsedM = {}; // 'Month Sold' -> true when that month's rows are collapsed (Sold view)
let _stockDeviceNames = [];
let _stockBrandKeys = [];
let _stockMonthKeys = [];

const _STOCK_AMT_COLS = ['cost price', 'selling price', 'kunal telecom', 'aks share'];

const _STOCK_DISPLAY = {
  available:   { cols: ['Device','Brand','Model','IMEI_1','Cost Price'] },
  sold:        { cols: ['Month Sold','Selling Date','Model','Customer Name','Payment Mode','IMEI_1','Cost Price','Selling Price','Kunal Telecom','AKS Share'] },
  undelivered: { cols: ['Order Date','Model','Marketplace','Paid By','Cost Price'] },
};

// Columns sorted in descending order per view
const _STOCK_SORT_DESC = {
  sold:        { 'Month Sold': true, 'Selling Date': true },
  undelivered: { 'Order Date': true },
};

async function initStockPage() {
  setStockFilter('available');
  if (!_stockLoaded) await loadStock();
  else renderStock();
}

function setStockFilter(f) {
  _stockFilter = f;
  document.querySelectorAll('#stock-pills .stock-tab').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-f') === f);
  });
  renderStock();
}

async function loadStock() {
  showLoader();
  try {
    const res = await gasGet('readStock');
    if (!res.ok) { showAlert('Failed to load stock: ' + (res.error || ''), 'e'); return; }
    const stock = (res.stock && res.stock.headers) ? res.stock : { headers: [], rows: [] };
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
    _stock = stock;
    _stockLoaded = true;
    renderStock();
    if (!_stock.headers.length) showAlert('Stock sheet is empty.', 'e');
  } catch (err) {
    showAlert('Failed to load stock: ' + err.message, 'e');
  } finally {
    hideLoader();
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

function toggleStockMonth(month) {
  _stockCollapsedM[month] = !_stockCollapsedM[month];
  renderStock();
}

function toggleStockAllDevices() {
  const sets = _stockFilter === 'available'
    ? [ [ _stockCollapsedD, _stockDeviceNames ], [ _stockCollapsedB, _stockBrandKeys ] ]
    : [ [ _stockCollapsedM, _stockMonthKeys ] ];
  let any = false;
  sets.forEach(([store, keys]) => keys.forEach(k => { if (store[k]) any = true; }));
  sets.forEach(([store, keys]) => keys.forEach(k => { store[k] = !any; }));
  renderStock();
}

function _toggleCell(label, cls, onclickExpr, collapsed) {
  const chev = collapsed ? '▶' : '▼';
  return '<td class="' + cls + '" onclick="' + onclickExpr + '">'
    + '<span class="st-chev">' + chev + '</span> ' + _esc(label) + '</td>';
}

// Available view: flat rows grouped by Device, then Brand (data already sorted)
function buildAvailableRows(data, headers) {
  const dIdx = _colIndex(headers, 'Device');
  const bIdx = _colIndex(headers, 'Brand');
  const mIdx = _colIndex(headers, 'Model');
  const iIdx = _colIndex(headers, 'IMEI_1');
  const cIdx = _colIndex(headers, 'Cost Price');

  const devices = [];
  data.forEach(r => {
    const d = String(r[dIdx] == null ? '' : r[dIdx]).trim() || '(no device)';
    const b = String(r[bIdx] == null ? '' : r[bIdx]).trim() || '(no brand)';
    let devG = devices.length ? devices[devices.length - 1] : null;
    if (!devG || devG.dev !== d) { devG = { dev: d, brands: [] }; devices.push(devG); }
    const brands = devG.brands;
    if (brands.length && brands[brands.length - 1].brand === b) brands[brands.length - 1].rows.push(r);
    else brands.push({ brand: b, rows: [r] });
  });

  _stockDeviceNames = devices.map(g => g.dev);
  _stockBrandKeys = devices.reduce((acc, g) => acc.concat(g.brands.map(bg => g.dev + '||' + bg.brand)), []);

  const devCell = (d, collapsed) => _toggleCell(d, 'st-dev-cell',
    "toggleStockDevice('" + _jsStr(d) + "')", collapsed);
  const brandCell = (b, d, collapsed) => _toggleCell(b, 'st-brand-cell',
    "toggleStockBrand('" + _jsStr(d) + "','" + _jsStr(b) + "')", collapsed);

  const html = [];
  devices.forEach(devG => {
    const d = devG.dev;
    if (_stockCollapsedD[d]) {
      const allRows = devG.brands.reduce((a, bg) => a.concat(bg.rows), []);
      html.push('<tr>' + devCell(d, true) + '<td></td><td></td><td></td><td>'
        + _stockAmt(_sumCost(allRows, cIdx)) + '</td></tr>');
      return;
    }
    devG.brands.forEach((bg, bi) => {
      const bKey = d + '||' + bg.brand;
      if (_stockCollapsedB[bKey]) {
        html.push('<tr>' + (bi === 0 ? devCell(d, false) : '<td></td>')
          + brandCell(bg.brand, d, true) + '<td></td><td></td><td>'
          + _stockAmt(_sumCost(bg.rows, cIdx)) + '</td></tr>');
        return;
      }
      bg.rows.forEach((r, ri) => {
        html.push('<tr>'
          + (bi === 0 && ri === 0 ? devCell(d, false) : '<td></td>')
          + (ri === 0 ? brandCell(bg.brand, d, false) : '<td></td>')
          + '<td>' + _stockCell(r[mIdx], 'Model') + '</td>'
          + '<td>' + _stockCell(r[iIdx], 'IMEI_1') + '</td>'
          + '<td>' + _stockCell(r[cIdx], 'Cost Price') + '</td></tr>');
      });
    });
  });
  return html.join('');
}

// Sold view: flat rows grouped by Month Sold; collapsed rows sum Kunal Telecom + AKS Share
function buildSoldRows(data, headers) {
  const order = ['Month Sold','Selling Date','Model','Customer Name','Payment Mode','IMEI_1','Cost Price','Selling Price','Kunal Telecom','AKS Share'];
  const idx = order.map(n => _colIndex(headers, n));
  const mIdx = idx[0];
  const ktIdx = _colIndex(headers, 'Kunal Telecom');
  const aksIdx = _colIndex(headers, 'AKS Share');

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
      "toggleStockMonth('" + _jsStr(m) + "')", collapsed);

    if (collapsed) {
      const cells = idx.map((ci, i) => {
        if (i === 0) return monthCell;
        if (i === 6) return '<td>' + _stockAmt(_sumCost(mg.rows, ci)) + '</td>';
        if (i === 7) return '<td>' + _stockAmt(_sumCost(mg.rows, ci)) + '</td>';
        if (i === 8) return '<td>' + _stockAmt(_sumCost(mg.rows, ktIdx)) + '</td>';
        if (i === 9) return '<td>' + _stockAmt(_sumCost(mg.rows, aksIdx)) + '</td>';
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

function renderStock() {
  const el = $('stock-results');
  if (!el) return;
  const { headers, rows } = _stock;
  if (!headers.length) { el.innerHTML = '<div class="empty">No stock data found.</div>'; return; }

  let cols = headers;
  let data = rows;
  let grouped = false;

  if (_stockFilter === 'available' || _stockFilter === 'sold' || _stockFilter === 'undelivered') {
    const cfg = _STOCK_DISPLAY[_stockFilter];
    cols = cfg.cols;
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
    const iIdx = _colIndex(headers, 'IMEI_1');
    if (_stockFilter === 'available') data = rows.filter(r => {
      const hasImei = iIdx >= 0 && r[iIdx] != null && String(r[iIdx]).trim() !== '';
      return hasImei && !isSold(r);
    });
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
    if (_stockFilter === 'available' || _stockFilter === 'sold') {
      grouped = true;
    } else {
      data = data.map(r => idx.map(ci => r[ci]));
    }
  }

  const tbody = grouped
    ? (_stockFilter === 'available' ? buildAvailableRows(data, headers) : buildSoldRows(data, headers))
    : data.map(r => '<tr>' + r.map((c, i) => '<td>' + _stockCell(c, cols[i]) + '</td>').join('') + '</tr>').join('');

  let anyCollapsed = false;
  if (grouped) {
    anyCollapsed = _stockFilter === 'available'
      ? _stockDeviceNames.some(d => _stockCollapsedD[d]) || _stockBrandKeys.some(k => _stockCollapsedB[k])
      : _stockMonthKeys.some(k => _stockCollapsedM[k]);
  }
  const collapseBtn = grouped
    ? ' <button class="btn btn-sm" onclick="toggleStockAllDevices()" style="margin-left:8px">' + (anyCollapsed ? 'Expand all' : 'Collapse all') + '</button>'
    : '';

  el.innerHTML = `<div style="font-size:12px;color:#888;margin-bottom:0.5rem">${data.length} of ${rows.length} rows${collapseBtn}</div>
    <div style="overflow-x:auto;border:0.5px solid #eee;border-radius:8px">
      <table class="emi-table${_stockFilter === 'sold' ? ' stock-table' : ''}">
        <thead><tr>${cols.map(h => '<th>' + _esc(h) + '</th>').join('')}</tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
}
