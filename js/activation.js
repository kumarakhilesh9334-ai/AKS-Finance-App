// ── ACTIVATION CHECK (Stock tab, admin only) ────────────────────────────────
// The app is static, so the browser cannot start Playwright by itself. The
// "Check now" button talks to a small local server (activation-check/server.js)
// that drives a real Chromium window. When a brand shows a captcha, the user
// solves it in that window and the batch continues on its own.
//
// Output is one CSV. Nothing is written back to the Stock sheet.

const _ACT_DEFAULT_API = ['http://127.0.0.1:8787', 'http://localhost:8787'];
const _ACT_POLL_MS = 1500;

let _actApiBase = null;
let _actHealth = null;
let _actItems = [];
let _actJob = null;
let _actPollTimer = null;
let _actPollBusy = false;

function _actEsc(s) {
  if (typeof _esc === 'function') return _esc(s);
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _actEl(id) {
  return document.getElementById(id);
}

async function _actFetch(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
  try {
    const res = await fetch(url, Object.assign({ cache: 'no-store' }, opts || {}, { signal: ctrl.signal }));
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    return { status: res.status, ok: res.ok, data: data };
  } finally {
    clearTimeout(timer);
  }
}

// ── Talking to the local checker ────────────────────────────────────────────

function _actSavedApi() {
  try {
    let url = (localStorage.getItem('aks_activation_api') || '').replace(/\/+$/, '');
    if (url && !/^https?:\/\//i.test(url)) url = 'http://' + url;
    return url;
  } catch (e) { return ''; }
}

async function _actFindApi(force) {
  if (_actApiBase && !force) return _actApiBase;
  const list = [];
  const saved = _actSavedApi();
  if (saved) list.push(saved);
  _ACT_DEFAULT_API.forEach(u => { if (list.indexOf(u) === -1) list.push(u); });
  for (let i = 0; i < list.length; i++) {
    const base = list[i];
    try {
      const r = await _actFetch(base + '/api/health', { method: 'GET' }, 2500);
      if (r.ok && r.data && r.data.ok) {
        _actApiBase = base;
        _actHealth = r.data;
        return base;
      }
    } catch (e) { /* try the next candidate */ }
  }
  _actApiBase = null;
  return null;
}

async function _actRefreshServer() {
  const box = _actEl('act-server');
  if (box) box.className = 'act-server';
  if (box) box.innerHTML = '<span class="act-spin"></span>Connecting to the local checker…';
  const base = await _actFindApi(true);
  if (!base) {
    _actRenderServerOffline();
  } else {
    _actRenderServerOnline();
    _actUpdateButtons();
    _actRestoreJob();
  }
  return base;
}

function _actRenderServerOffline() {
  const box = _actEl('act-server');
  if (!box) return;
  box.className = 'act-server bad';
  box.innerHTML =
    '<b>The local checker is not running.</b>'
    + '<div style="margin-top:6px">On the computer that has the app folder, double-click '
    + '<b>Start Activation Checker.bat</b>. It installs Playwright once, starts the checker at '
    + '<code>http://127.0.0.1:8787</code> and opens the app there.</div>'
    + '<div style="margin-top:6px">Leave that black window open, then press '
    + '<b>Retry connection</b>.</div>'
    + '<button class="btn btn-sm" style="margin-top:8px" onclick="retryActivationServer()">Retry connection</button>';
  _actUpdateButtons();
}

function _actRenderServerOnline() {
  const box = _actEl('act-server');
  if (!box) return;
  const h = _actHealth || {};
  const adapters = Array.isArray(h.adapters) ? h.adapters.map(a => a.label).join(', ') : '';
  if (h.ready === false) {
    box.className = 'act-server bad';
    box.innerHTML =
      '<b>Checker connected, but Chromium is not installed yet.</b>'
      + '<div style="margin-top:6px">Close the checker window and run '
      + '<b>Start Activation Checker.bat</b> again. It will finish the download.</div>'
      + '<button class="btn btn-sm" style="margin-top:8px" onclick="retryActivationServer()">Retry</button>';
  } else {
    box.className = 'act-server ok';
    box.innerHTML =
      '✓ Checker connected. Supported brands: <b>' + _actEsc(adapters || 'none') + '</b>.'
      + '<div style="margin-top:4px;color:#4a7a55">A Chromium window will open. It asks for a captcha '
      + 'for every IMEI — solve each one there and the batch continues by itself. The last Stock row '
      + 'is checked first.</div>';
  }
}

function retryActivationServer() {
  const inp = _actEl('act-server-url');
  if (inp) {
    let value = String(inp.value || '').trim().replace(/\/+$/, '');
    if (value && !/^https?:\/\//i.test(value)) value = 'http://' + value;
    inp.value = value;
    try {
      if (value) localStorage.setItem('aks_activation_api', value);
      else localStorage.removeItem('aks_activation_api');
    } catch (e) {}
  }
  _actApiBase = null;
  _actRefreshServer();
}

// ── Gathering the units to check ────────────────────────────────────────────

// The Stock sheet also carries tablets, appliances and accessories. An IMEI
// activation check only makes sense for phones, so the batch keeps Mobile rows.
function _actIsMobileDevice(value) {
  return /^mobiles?$/i.test(String(value || '').trim());
}

function _actSupportedLabels() {
  const adapters = _actHealth && Array.isArray(_actHealth.adapters) ? _actHealth.adapters : [];
  return adapters.map(a => a.label).join(', ') || 'none';
}

function _actCollectItems() {
  if (!_stock || !_stock.headers || !_stock.headers.length) return [];
  const h = _stock.headers;
  const keep = _availFilter(h);
  const iOf = n => _colIndex(h, n);
  const dIdx = iOf('Device'), bIdx = iOf('Brand'), mIdx = iOf('Model'), sIdx = iOf('Specs');
  const i1Idx = iOf('IMEI_1'), i2Idx = iOf('IMEI_2'), cIdx = iOf('Cost Price'), oIdx = iOf('Order Date');
  const text = (r, i) => (i >= 0 && r[i] != null) ? String(r[i]).trim() : '';
  const mobileOnly = dIdx >= 0;
  const out = [];
  _stock.rows.forEach((r, idx) => {
    if (!keep(r)) return;
    if (mobileOnly && !_actIsMobileDevice(text(r, dIdx))) return;
    const imei1 = text(r, i1Idx);
    if (!imei1) return;
    out.push({
      sheetRow: idx + 2, // header is spreadsheet row 1
      device: text(r, dIdx),
      brand: text(r, bIdx),
      model: text(r, mIdx),
      specs: text(r, sIdx),
      imei1: imei1,
      imei2: text(r, i2Idx),
      costPrice: cIdx >= 0 && r[cIdx] != null ? r[cIdx] : '',
      orderDate: text(r, oIdx),
    });
  });
  return out;
}

function _actBrandCounts(items) {
  const map = {};
  items.forEach(it => {
    const brand = it.brand || '(no brand)';
    map[brand] = (map[brand] || 0) + 1;
  });
  return Object.keys(map).sort((a, b) => a.localeCompare(b)).map(brand => ({ brand: brand, count: map[brand] }));
}

function _actBrandSupported(brand) {
  const adapters = _actHealth && Array.isArray(_actHealth.adapters) ? _actHealth.adapters : [];
  if (!adapters.length) return null;
  const b = String(brand || '').toLowerCase();
  return adapters.some(a =>
    b.indexOf(String(a.id || '').toLowerCase()) !== -1
    || b.indexOf(String(a.label || '').toLowerCase()) !== -1);
}

function _actRenderSummary() {
  const el = _actEl('act-summary');
  if (!el) return;
  if (!_actItems.length) {
    el.innerHTML = '<b>No available Mobile units with an IMEI_1.</b> Only rows with Device = Mobile are checked.';
    return;
  }
  const brands = _actBrandCounts(_actItems);
  const skipped = brands.filter(b => _actBrandSupported(b.brand) === false)
    .reduce((sum, b) => sum + b.count, 0);
  const pills = brands.map(b => {
    const supported = _actBrandSupported(b.brand);
    return '<span class="act-brand' + (supported === false ? ' no' : '') + '">'
      + _actEsc(b.brand) + ' · ' + b.count + (supported === false ? ' · not checked' : '') + '</span>';
  }).join('');

  let extra = '';
  if (skipped) {
    extra = '<div style="margin-top:6px">' + skipped + ' unit' + (skipped === 1 ? '' : 's')
      + ' from a brand with no adapter will not be sent. Supported for now: <b>'
      + _actEsc(_actSupportedLabels()) + '</b>.</div>';
  }
  el.innerHTML =
    '<div><b>' + _actItems.length + '</b> available Mobile unit' + (_actItems.length === 1 ? '' : 's')
    + ' will be checked by their IMEI.</div>'
    + '<div class="act-brand-list">' + pills + '</div>'
    + extra
    + '<div style="margin-top:6px;color:#777">A CSV report is downloaded at the end. The Stock sheet is never changed.</div>';
}

// ── Job state and polling ───────────────────────────────────────────────────

function _actStatusRank(status) {
  if (status === 'ACTIVATED') return 0;
  if (status === 'NOT ACTIVATED') return 1;
  if (status === 'NOT FOUND') return 2;
  if (status === 'SKIPPED') return 3;
  return 4;
}

function _actChipClass(status) {
  if (status === 'ACTIVATED') return 'activated';
  if (status === 'ERROR') return 'error';
  if (status === 'SKIPPED') return 'skipped';
  return '';
}

function _actRenderJob() {
  const job = _actJob;
  const progWrap = _actEl('act-progress-wrap');
  const phase = _actEl('act-phase');
  const bar = _actEl('act-progress-bar');
  const counts = _actEl('act-counts');
  const logWrap = _actEl('act-log-wrap');
  const log = _actEl('act-log');

  if (!job) {
    if (progWrap) progWrap.style.display = 'none';
    if (logWrap) logWrap.style.display = 'none';
    const res = _actEl('act-results');
    if (res) res.innerHTML = '';
    _actUpdateButtons();
    return;
  }

  const running = job.status === 'queued' || job.status === 'running';
  if (progWrap) progWrap.style.display = 'block';
  if (bar) {
    const pct = job.total ? Math.round((job.completed / job.total) * 100) : 0;
    bar.style.width = pct + '%';
  }
  if (phase) {
    const captcha = job.phase === 'waiting_for_captcha';
    phase.className = 'act-phase' + (captcha ? ' captcha' : '');
    let text = job.message || '';
    if (captcha) text = '⏳ ' + text;
    if (job.status === 'stopped') text = 'Stopped after ' + job.completed + ' of ' + job.total + ' units.';
    if (job.status === 'error' && job.error) text = job.error;
    phase.textContent = text;
  }

  if (counts) {
    const c = job.counts || {};
    const chips = [];
    const defs = [
      ['ACTIVATED', 'Activated', 'activated'],
      ['NOT ACTIVATED', 'Not activated', ''],
      ['NOT FOUND', 'Not found', ''],
      ['SKIPPED', 'Skipped', 'skipped'],
      ['ERROR', 'Errors', 'error'],
    ];
    defs.forEach(([key, label, cls]) => {
      if (!c[key]) return;
      chips.push('<span class="act-count ' + cls + '">' + label + ': ' + c[key] + '</span>');
    });
    chips.push('<span class="act-count">' + job.completed + ' / ' + job.total + ' checked</span>');
    counts.innerHTML = chips.join('');
  }

  if (logWrap && log) {
    logWrap.style.display = job.logs && job.logs.length ? 'block' : 'none';
    if (job.logs && job.logs.length) {
      log.innerHTML = job.logs.slice(-80).map(entry => {
        const time = String(entry.at || '').slice(11, 19);
        const cls = entry.level === 'warn' ? 'warn' : entry.level === 'error' ? 'error' : entry.level === 'success' ? 'success' : '';
        return '<div class="' + cls + '">' + _actEsc(time + '  ' + entry.text) + '</div>';
      }).join('');
      log.scrollTop = log.scrollHeight;
    }
  }

  _actRenderResults(job);
  _actUpdateButtons();
}

function _actRenderResults(job) {
  const el = _actEl('act-results');
  if (!el) return;
  const all = Array.isArray(job.results) ? job.results : [];
  if (!all.length) { el.innerHTML = ''; return; }

  const activated = all.filter(r => r.status === 'ACTIVATED');
  const active = job.status === 'queued' || job.status === 'running';
  const recent = activated.filter(r => {
    const n = Number(r.daysSince);
    return r.daysSince !== '' && r.daysSince !== null && !isNaN(n) && n >= 0 && n <= 30;
  }).length;

  const list = active
    ? all.slice(-8).reverse()
    : all.slice().sort((a, b) => {
        const ra = _actStatusRank(a.status), rb = _actStatusRank(b.status);
        if (ra !== rb) return ra - rb;
        return String(b.activationDate || '').localeCompare(String(a.activationDate || ''));
      }).slice(0, 40);

  const header = active
    ? 'Recently checked'
    : (activated.length
        ? '<b>' + activated.length + '</b> unit' + (activated.length === 1 ? ' was' : 's were')
          + ' already activated while still marked Available'
          + (recent ? ' — <b>' + recent + '</b> in the last 30 days' : '') + '.'
        : 'No activated units found.');
  let hint = (!active && activated.length)
    ? '<div style="color:#777;margin-top:2px">These are likely unrecorded sales. Mark them sold in the Stock sheet and download the CSV for the full list.</div>'
    : '';
  if (!active && all.length > list.length) {
    hint += '<div style="color:#777;margin-top:2px">Showing the first ' + list.length + ' of ' + all.length
      + '. The CSV has every unit.</div>';
  }

  const rows = list.map(r => {
    const bits = [];
    if (r.status === 'ACTIVATED' && r.activationDate) {
      bits.push('Activated ' + r.activationDate);
      if (r.daysSince !== '' && r.daysSince !== null && r.daysSince !== undefined) {
        const n = Number(r.daysSince);
        bits.push(n === 0 ? 'today' : (n > 0 ? n + ' day' + (n === 1 ? '' : 's') + ' ago' : 'future date'));
      }
    } else if (r.status === 'ERROR' || r.status === 'SKIPPED' || r.status === 'NOT FOUND') {
      bits.push(r.error || r.status);
    }
    const name = [r.brand, r.model].filter(Boolean).join(' ') || '(unknown model)';
    const specs = r.specs ? ' · ' + r.specs : '';
    return '<div class="act-hit">'
      + '<div class="act-hit-hd"><span>' + _actEsc(name) + '</span>'
      + '<span class="act-count ' + _actChipClass(r.status) + '">' + _actEsc(r.status) + '</span></div>'
      + '<div class="act-hit-sub">IMEI ' + _actEsc(r.imei1) + specs
      + (bits.length ? ' · ' + _actEsc(bits.join(' · ')) : '') + '</div>'
      + '</div>';
  }).join('');

  el.innerHTML = '<div class="act-result">' + header + hint + rows + '</div>';
}

function _actUpdateButtons() {
  const start = _actEl('act-start');
  const stop = _actEl('act-stop');
  const download = _actEl('act-download');
  const job = _actJob;
  const running = !!(job && (job.status === 'queued' || job.status === 'running'));

  if (start) {
    start.style.display = running ? 'none' : '';
    start.disabled = !_actHealth || _actHealth.ready === false || !_actItems.length;
    start.textContent = (job && (job.status === 'done' || job.status === 'stopped' || job.status === 'error'))
      ? 'Check again' : 'Check now';
  }
  if (stop) stop.style.display = running ? '' : 'none';
  if (download) {
    download.style.display = job && job.csvReady ? '' : 'none';
    download.disabled = false;
  }
}

function _actStopPolling() {
  if (_actPollTimer) {
    clearInterval(_actPollTimer);
    _actPollTimer = null;
  }
}

async function _actPollOnce() {
  if (!_actJob || !_actApiBase || _actPollBusy) return;
  _actPollBusy = true;
  try {
    const r = await _actFetch(
      _actApiBase + '/api/job/' + encodeURIComponent(_actJob.id), { method: 'GET' }, 8000);
    if (r.ok && r.data && r.data.job) {
      _actJob = r.data.job;
      _actRenderJob();
    } else if (r.status === 404) {
      _actStopPolling();
      const phase = _actEl('act-phase');
      if (phase) phase.textContent = 'This check is no longer available. Start a new one.';
      _actJob = null;
      _actUpdateButtons();
      try { localStorage.removeItem('aks_activation_job'); } catch (e) {}
    }
  } catch (e) {
    // The server may be restarting. Keep the last state and retry next tick.
  } finally {
    _actPollBusy = false;
  }
  if (_actJob && _actJob.status !== 'queued' && _actJob.status !== 'running') _actStopPolling();
}

function _actStartPolling() {
  _actStopPolling();
  _actPollTimer = setInterval(_actPollOnce, _ACT_POLL_MS);
  _actPollOnce();
}

function _actAdoptJob(job) {
  _actJob = job;
  try {
    localStorage.setItem('aks_activation_job', JSON.stringify({ base: _actApiBase, id: job.id }));
  } catch (e) {}
  _actRenderJob();
  if (job.status === 'queued' || job.status === 'running') _actStartPolling();
  else _actStopPolling();
}

async function _actRestoreJob() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('aks_activation_job') || 'null'); } catch (e) {}
  if (!saved || !saved.id || !_actApiBase) return;
  try {
    const r = await _actFetch(_actApiBase + '/api/job/' + encodeURIComponent(saved.id), { method: 'GET' }, 6000);
    if (r.ok && r.data && r.data.job) {
      _actJob = r.data.job;
      _actRenderJob();
      if (_actJob.status === 'queued' || _actJob.status === 'running') _actStartPolling();
      return;
    }
  } catch (e) { /* fall through and forget it */ }
  try { localStorage.removeItem('aks_activation_job'); } catch (e) {}
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function openActivationModal() {
  if (!_stockIsAdmin()) { showAlert('Admin only.', 'e'); return; }
  const modal = _actEl('activation-modal');
  if (!modal) return;

  _actItems = _actCollectItems();
  _actJob = null;
  _actHealth = null;
  _actApiBase = null;
  _actStopPolling();

  const urlInput = _actEl('act-server-url');
  if (urlInput) urlInput.value = _actSavedApi() || _ACT_DEFAULT_API[0];

  _actRenderSummary();
  _actRenderJob();
  _actRenderServerOffline();
  const box = _actEl('act-server');
  if (box) {
    box.className = 'act-server';
    box.innerHTML = '<span class="act-spin"></span>Connecting to the local checker…';
  }

  modal.style.display = 'flex';
  const probe = _actRefreshServer();

  // The button can be pressed before the Stock tab has finished its first
  // load. Wait for the table instead of telling the user there is no stock.
  if (!_stock.headers.length && typeof loadStock === 'function') {
    const summary = _actEl('act-summary');
    if (summary) summary.textContent = 'Loading the Stock sheet…';
    try { await loadStock(); } catch (e) { /* summary will explain */ }
    _actItems = _actCollectItems();
    _actRenderSummary();
    _actUpdateButtons();
  }
  await probe;
}

function closeActivationModal() {
  const modal = _actEl('activation-modal');
  if (modal) modal.style.display = 'none';
  // The batch keeps running on the server; stop only the UI polling.
  _actStopPolling();
}

async function startActivationCheck() {
  if (!_stockIsAdmin()) { showAlert('Admin only.', 'e'); return; }
  _actItems = _actCollectItems();
  _actRenderSummary();
  if (!_actItems.length) { showAlert('No available Mobile units with an IMEI_1.', 'e'); return; }

  const btn = _actEl('act-start');
  if (btn) btn.disabled = true;
  try {
    const base = await _actFindApi(true);
    if (!base) {
      _actRenderServerOffline();
      return;
    }
    // Only send brands the checker has an adapter for. Others stay visible in
    // the summary but are left out of the batch, so the run is all Nothing.
    const items = _actItems.filter(it => _actBrandSupported(it.brand) !== false);
    const omitted = _actItems.length - items.length;
    if (!items.length) {
      showAlert('None of these brands has an adapter yet. Supported: ' + _actSupportedLabels() + '.', 'e');
      _actUpdateButtons();
      return;
    }
    const r = await _actFetch(base + '/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items }),
    }, 20000);

    if (r.status === 409 && r.data && r.data.job) {
      _actAdoptJob(r.data.job);
      showAlert('A check is already running. Showing its progress.', 's');
      return;
    }
    if (!r.data || !r.data.ok || !r.data.job) {
      throw new Error((r.data && r.data.error) || ('The checker replied with HTTP ' + r.status + '.'));
    }
    _actAdoptJob(r.data.job);
    showAlert('Check started for ' + items.length + ' unit' + (items.length === 1 ? '' : 's') + '.'
      + (omitted ? ' ' + omitted + ' other unit' + (omitted === 1 ? '' : 's') + ' left out (brand not supported yet).' : '')
      + ' A Chromium window will open — solve each captcha it shows.', 's');
  } catch (err) {
    showAlert('Could not start the check: ' + err.message, 'e');
    _actUpdateButtons();
  }
}

async function stopActivationCheck() {
  if (!_actJob || !_actApiBase) return;
  if (!confirm('Stop the check after the current IMEI?')) return;
  const btn = _actEl('act-stop');
  if (btn) btn.disabled = true;
  try {
    const r = await _actFetch(_actApiBase + '/api/job/' + encodeURIComponent(_actJob.id) + '/stop',
      { method: 'POST' }, 10000);
    if (r.data && r.data.job) {
      _actJob = r.data.job;
      _actRenderJob();
    }
  } catch (err) {
    showAlert('Could not stop the check: ' + err.message, 'e');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function downloadActivationCsv() {
  if (!_actJob || !_actJob.csvReady || !_actApiBase) return;
  const btn = _actEl('act-download');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(_actApiBase + '/api/job/' + encodeURIComponent(_actJob.id) + '/csv',
      { cache: 'no-store' });
    if (!res.ok) throw new Error('The checker replied with HTTP ' + res.status + '.');
    const blob = await res.blob();
    const name = _actJob.csvName || 'activation-report.csv';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showAlert('CSV downloaded: ' + name, 's');
  } catch (err) {
    showAlert('Could not download the CSV: ' + err.message, 'e');
  } finally {
    if (btn) btn.disabled = false;
  }
}
