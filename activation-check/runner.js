// ── Activation check runner ─────────────────────────────────────────────────
// One Chromium window and one page for the whole batch. Brands with a captcha
// ask for a solve per IMEI; the runner just moves from one unit to the next.
// The server keeps the Job objects in memory; this module owns the browser and
// the CSV report.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const config = require('./config');
const { buildCsv } = require('./csv');
const { findAdapter, listAdapters } = require('./brands');

const jobs = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localStamp(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

function ymd(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// Local midnight, so "days since" does not shift by 5.5 hours in IST.
function startOfToday() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysBetween(ymdString) {
  const m = String(ymdString || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(then.getTime())) return null;
  return Math.round((startOfToday().getTime() - then.getTime()) / 86400000);
}

function labelOf(item) {
  const bits = [];
  if (item.brand) bits.push(item.brand);
  if (item.model) bits.push(item.model);
  const name = bits.join(' ') || item.imei1 || 'unit';
  return name + ' (' + (item.imei1 || 'no IMEI') + ')';
}

function stockFields(item) {
  return {
    brand: item.brand || '',
    model: item.model || '',
    specs: item.specs || '',
    imei1: item.imei1 || '',
    imei2: item.imei2 || '',
    device: item.device || '',
    costPrice: item.costPrice === undefined || item.costPrice === null ? '' : item.costPrice,
    orderDate: item.orderDate || '',
    sheetRow: item.sheetRow === undefined ? '' : item.sheetRow,
  };
}

function makeResult(item, extra) {
  // Stock fields win over anything the portal echoed back: the report must
  // identify the row we checked, not a re-formatted IMEI from the brand site.
  return Object.assign({
    activationDate: '',
    daysSince: '',
    warning: [],
    productModel: '',
    productStatus: '',
    error: '',
    source: '',
    checkedAt: new Date().toISOString(),
  }, extra, stockFields(item));
}

// ── Job ─────────────────────────────────────────────────────────────────────

class Job {
  constructor(items) {
    this.id = crypto.randomBytes(8).toString('hex');
    this.items = items;
    this.total = items.length;
    this.results = [];
    this.logs = [];
    this.status = 'queued';
    this.phase = 'queued';
    this.message = 'Waiting to start…';
    this.current = null;
    this.createdAt = new Date().toISOString();
    this.startedAt = null;
    this.finishedAt = null;
    this.csvPath = null;
    this.csvName = null;
    this.error = null;
    this.cancelRequested = false;
    this._context = null;
    this._page = null;
  }

  log(text, level) {
    this.logs.push({ at: new Date().toISOString(), level: level || 'info', text: String(text) });
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
  }

  setPhase(phase, message) {
    this.phase = phase;
    if (message) this.message = message;
  }

  counts() {
    const out = { ACTIVATED: 0, 'NOT ACTIVATED': 0, 'NOT FOUND': 0, SKIPPED: 0, ERROR: 0 };
    this.results.forEach(r => {
      if (out[r.status] === undefined) out[r.status] = 0;
      out[r.status]++;
    });
    return out;
  }

  snapshot() {
    return {
      id: this.id,
      status: this.status,
      phase: this.phase,
      message: this.message,
      total: this.total,
      completed: this.results.length,
      counts: this.counts(),
      results: this.results,
      logs: this.logs.slice(-120),
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      csvReady: !!this.csvPath,
      csvName: this.csvName,
      error: this.error,
    };
  }

  stop() {
    if (this.status !== 'running' && this.status !== 'queued') return false;
    this.cancelRequested = true;
    this.setPhase('stopping', 'Stopping after the current IMEI…');
    this.log('Stop requested.', 'warn');
    // A captcha wait can last minutes. Closing the window is the only way to
    // break out of it immediately; the runner treats the close as a stop.
    if (this._context) {
      this._context.close().catch(() => {});
    }
    return true;
  }
}

// ── Running one batch ───────────────────────────────────────────────────────

async function checkItem(job, page, item, progress) {
  const adapter = findAdapter(item);
  if (!adapter) {
    const supported = listAdapters().map(a => a.label).join(', ') || 'none';
    return makeResult(item, {
      status: 'SKIPPED',
      error: 'No adapter for brand "' + (item.brand || '(blank)') + '". Supported: ' + supported + '.',
    });
  }

  const log = (text, level) => job.log(labelOf(item) + ': ' + text, level);
  const setPhase = (phase, message) => job.setPhase(phase, message);

  log('Using ' + adapter.label + ' adapter.');
  try {
    const raw = await adapter.run({
      page,
      item,
      log,
      setPhase,
      position: progress ? progress.position : 1,
      total: progress ? progress.total : 1,
    });
    const result = makeResult(item, raw || {});
    result.activationDate = result.activationDate || '';
    result.daysSince = result.activationDate ? daysBetween(result.activationDate) : '';
    if (result.daysSince === null) result.daysSince = '';
    result.warning = [];
    if (result.status === 'ACTIVATED') {
      if (typeof result.daysSince === 'number' && result.daysSince < 0) {
        result.warning.push('Activation date is in the future — verify this portal result.');
      }
      result.warning.push('Activated but still marked Available in Stock — likely an unrecorded sale.');
    }
    if (result.status === 'ACTIVATED' && result.activationDate) {
      log('Activated on ' + result.activationDate + '.');
    } else {
      log(result.status + (result.error ? ': ' + result.error : ''));
    }
    return result;
  } catch (err) {
    if (page.isClosed()) throw new Error('The Chromium window was closed.');
    log('Failed: ' + (err && err.message ? err.message : String(err)), 'error');
    return makeResult(item, {
      status: 'ERROR',
      error: err && err.message ? err.message : String(err),
    });
  }
}

const CSV_HEADERS = [
  'Activation Status',
  'Activation Date',
  'Days Since Activation',
  'Warning',
  'Brand',
  'Model',
  'Specs',
  'IMEI_1',
  'IMEI_2',
  'Stock Row',
  'Device',
  'Cost Price',
  'Order Date',
  'Product Model',
  'Product Status',
  'Error',
  'Checked At',
  'Source',
];

// Most useful first: activated units (newest activation first), then the rest.
const STATUS_RANK = { ACTIVATED: 0, 'NOT ACTIVATED': 1, 'NOT FOUND': 2, 'SKIPPED': 3, ERROR: 4 };

function reportRows(results) {
  return results.slice().sort((a, b) => {
    const ra = STATUS_RANK[a.status] === undefined ? 9 : STATUS_RANK[a.status];
    const rb = STATUS_RANK[b.status] === undefined ? 9 : STATUS_RANK[b.status];
    if (ra !== rb) return ra - rb;
    if (a.status === 'ACTIVATED' && b.status === 'ACTIVATED' && a.activationDate !== b.activationDate) {
      return String(b.activationDate).localeCompare(String(a.activationDate));
    }
    return String(a.imei1).localeCompare(String(b.imei1));
  });
}

function writeReport(job) {
  fs.mkdirSync(config.reportsDir, { recursive: true });
  const rows = reportRows(job.results).map(r => [
    r.status,
    r.activationDate,
    r.daysSince,
    (r.warning || []).join(' '),
    r.brand,
    r.model,
    r.specs,
    r.imei1,
    r.imei2,
    r.sheetRow,
    r.device,
    r.costPrice,
    r.orderDate,
    r.productModel,
    r.productStatus,
    r.error,
    r.checkedAt,
    r.source,
  ]);
  // The BOM keeps Excel from mangling non-ASCII text in model names.
  const csv = '\ufeff' + buildCsv(CSV_HEADERS, rows);
  job.csvName = 'activation-report-' + localStamp(new Date()) + '.csv';
  job.csvPath = path.join(config.reportsDir, job.csvName);
  fs.writeFileSync(job.csvPath, csv, 'utf8');
  job.log('CSV written: ' + job.csvName, 'success');
}

async function runJob(job) {
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.setPhase('starting', 'Launching Chromium…');
  job.log('Starting batch: ' + job.total + ' unit' + (job.total === 1 ? '' : 's') + '.');
  job.log('Supported brands: ' + (listAdapters().map(a => a.label).join(', ') || 'none') + '.');

  try {
    fs.mkdirSync(config.profileDir, { recursive: true });
    fs.mkdirSync(config.reportsDir, { recursive: true });

    const context = await chromium.launchPersistentContext(config.profileDir, {
      headless: config.headless,
      viewport: null,
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      acceptDownloads: false,
      // Chromium otherwise shows "controlled by automated software" and makes
      // the reCAPTCHA challenge needlessly hostile. The profile stays dedicated.
      ignoreDefaultArgs: ['--enable-automation'],
      args: config.headless ? [] : ['--start-maximized'],
    });
    job._context = context;

    context.on('close', () => {
      job.log('Chromium window closed.', 'warn');
    });

    let page = context.pages()[0];
    if (!page) page = await context.newPage();
    job._page = page;
    page.setDefaultTimeout(60000);

    // Last sheet row first: new stock gets the captcha attention.
    const queue = config.reverseOrder ? job.items.slice().reverse() : job.items;
    job.log('Checking ' + (config.reverseOrder ? 'newest stock first' : 'sheet order') + '.');
    for (let i = 0; i < queue.length; i++) {
      if (job.cancelRequested) break;
      const item = queue[i];
      job.current = item.imei1 || '';
      job.setPhase('checking', 'Checking ' + (i + 1) + ' of ' + job.total + ': ' + labelOf(item));
      job.log('Checking ' + labelOf(item) + '.');
      const result = await checkItem(job, page, item, { position: i + 1, total: queue.length });
      job.results.push(result);
      if (i < queue.length - 1) await sleep(config.requestDelayMs);
    }

    if (job.cancelRequested) {
      job.status = 'stopped';
      job.setPhase('stopped', 'Stopped. Partial results are available.');
      job.log('Batch stopped after ' + job.results.length + ' of ' + job.total + ' units.', 'warn');
    } else {
      job.status = 'done';
      job.setPhase('done', 'Finished ' + job.results.length + ' unit' + (job.results.length === 1 ? '' : 's') + '.');
      job.log('Batch finished.', 'success');
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    job.error = message;
    // A closed window is a stop, not a crash: keep the partial report.
    const closed = /closed|Target page|browser has been closed/i.test(message);
    if (job.cancelRequested || closed) {
      job.status = job.cancelRequested ? 'stopped' : 'error';
      job.setPhase(job.cancelRequested ? 'stopped' : 'error',
        job.cancelRequested ? 'Stopped. Partial results are available.' : 'The browser window was closed.');
      job.log(message, 'warn');
    } else {
      job.status = 'error';
      job.setPhase('error', 'The batch failed.');
      job.log(message, 'error');
    }
  } finally {
    job.current = null;
    job.finishedAt = new Date().toISOString();
    try {
      if (job.results.length) writeReport(job);
    } catch (err) {
      job.log('Could not write the CSV: ' + (err && err.message ? err.message : String(err)), 'error');
      if (!job.error) job.error = 'Could not write the CSV report.';
    }
    if (job._context) {
      try { await job._context.close(); } catch (e) { /* already closed */ }
      job._context = null;
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

function findJob(id) {
  return jobs.get(String(id || '')) || null;
}

function activeJob() {
  for (const job of jobs.values()) {
    if (job.status === 'queued' || job.status === 'running') return job;
  }
  return null;
}

function startJob(items) {
  const job = new Job(items);
  jobs.set(job.id, job);
  // Keep the map from growing forever across a long-running server.
  if (jobs.size > 25) {
    const oldest = [...jobs.values()]
      .filter(j => j.status !== 'queued' && j.status !== 'running')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    if (oldest) jobs.delete(oldest.id);
  }
  runJob(job);
  return job;
}

module.exports = {
  startJob,
  findJob,
  activeJob,
  listAdapters,
  CSV_HEADERS,
};
