// ── Local activation-check server ───────────────────────────────────────────
// The app is static, so it cannot launch Playwright itself. This tiny server
// bridges the two: it serves the app (so the browser and the API share an
// origin) and exposes a small JSON API the Stock tab talks to.
//
//   GET  /api/health              → is the checker running, which brands work
//   POST /api/check   {items}     → start a batch
//   GET  /api/job/:id             → progress + results
//   POST /api/job/:id/stop        → stop after the current IMEI
//   GET  /api/job/:id/csv         → download the report
//
// It binds to loopback only. Nothing on the network can reach it.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');

const config = require('./config');
const runner = require('./runner');

const MAX_BODY_BYTES = 8 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Chrome asks for this when an HTTPS page (GitHub Pages) calls loopback.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '600');
}

function sendJson(res, status, payload) {
  cors(res);
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch (e) { reject(new Error('Request body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

// Only what the app needs. Blocking dot-folders and activation-check keeps the
// browser profile and the CSV reports out of reach of the static handler.
function safeStaticPath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); }
  catch (e) { return null; }
  if (decoded.indexOf('\0') !== -1) return null;
  decoded = decoded.replace(/\\/g, '/');
  if (decoded === '/' || decoded === '') decoded = '/index.html';
  const rel = decoded.replace(/^\/+/, '');
  const abs = path.resolve(config.rootDir, rel);
  if (abs !== config.rootDir && !abs.startsWith(config.rootDir + path.sep)) return null;
  const relCheck = path.relative(config.rootDir, abs).replace(/\\/g, '/');
  if (relCheck === 'activation-check' || relCheck.startsWith('activation-check/')) return null;
  if (relCheck.split('/').some(seg => seg.startsWith('.') && seg !== '.')) return null;
  // Only serve what the app actually needs. This keeps the Apps Script source,
  // this checker's own code and the Archive folder off the HTTP surface.
  const rootFiles = new Set(['index.html', 'manifest.json', 'sw.js', 'LOGO.jpeg', 'favicon.ico']);
  const firstDir = relCheck.split('/')[0];
  const assetDirs = new Set(['js', 'css', 'assets']);
  if (!rootFiles.has(relCheck) && !assetDirs.has(firstDir)) return null;
  return abs;
}

function serveStatic(req, res, urlPath) {
  const abs = safeStaticPath(urlPath);
  if (!abs) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=0, must-revalidate',
    });
    fs.createReadStream(abs).pipe(res);
    // Close the stream if the browser navigates away mid-download.
    res.on('close', () => { try { res.end(); } catch (e) {} });
  });
}

// A brand-new install has no .profile; the first launch has to download a
// browser. Detect it and say so instead of failing with a Playwright stack.
function playwrightStatus() {
  const marker = path.join(config.rootDir, 'activation-check', 'node_modules', 'playwright');
  const browserDir = process.env.PLAYWRIGHT_BROWSERS_PATH
    || path.join(process.env.LOCALAPPDATA || process.env.HOME || '', 'ms-playwright');
  const installed = fs.existsSync(marker);
  let browser = false;
  try {
    browser = fs.existsSync(browserDir)
      && fs.readdirSync(browserDir).some(name => /chromium/i.test(name));
  } catch (e) { /* leave false */ }
  return {
    dependencies: installed,
    browser: browser,
    browsersPath: browserDir,
  };
}

function normalizeItems(raw) {
  if (!Array.isArray(raw)) throw new Error('items must be an array.');
  if (!raw.length) throw new Error('There are no available units to check.');
  if (raw.length > config.maxItems) {
    throw new Error('Too many units in one batch (' + raw.length + '). The limit is ' + config.maxItems + '.');
  }
  const seen = new Set();
  const items = [];
  raw.forEach((src, i) => {
    if (!src || typeof src !== 'object') return;
    const str = key => String(src[key] === undefined || src[key] === null ? '' : src[key]).trim();
    const imei1 = str('imei1');
    if (!imei1) return;
    if (seen.has(imei1)) return;
    seen.add(imei1);
    const item = {
      index: i,
      sheetRow: src.sheetRow,
      device: str('device'),
      brand: str('brand'),
      model: str('model'),
      specs: str('specs'),
      imei1: imei1,
      imei2: str('imei2'),
      costPrice: src.costPrice === undefined || src.costPrice === null ? '' : src.costPrice,
      orderDate: str('orderDate'),
    };
    items.push(item);
  });
  if (!items.length) throw new Error('None of the selected rows has an IMEI_1.');
  return items;
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (url.pathname === '/api/health' && req.method === 'GET') {
    const p = playwrightStatus();
    sendJson(res, 200, {
      ok: true,
      ready: p.dependencies && p.browser,
      serveApp: true,
      adapters: runner.listAdapters(),
      host: config.host,
      port: config.port,
      playwright: p,
      note: p.dependencies && p.browser
        ? 'Ready.'
        : 'Run Start Activation Checker.bat once to install Playwright and Chromium.',
    });
    return true;
  }

  if (url.pathname === '/api/check' && req.method === 'POST') {
    const body = await readBody(req);
    const active = runner.activeJob();
    if (active) {
      sendJson(res, 409, {
        ok: false,
        error: 'A check is already running.',
        job: active.snapshot(),
      });
      return true;
    }
    const items = normalizeItems(body.items);
    const job = runner.startJob(items);
    sendJson(res, 202, { ok: true, job: job.snapshot() });
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'job' && parts[2]) {
    const job = runner.findJob(parts[2]);
    if (!job) {
      sendJson(res, 404, { ok: false, error: 'Job not found. It may have expired.' });
      return true;
    }
    if (parts[3] === 'stop' && req.method === 'POST') {
      const stopped = job.stop();
      sendJson(res, 200, { ok: true, stopped: stopped, job: job.snapshot() });
      return true;
    }
    if (parts[3] === 'csv' && req.method === 'GET') {
      if (!job.csvPath) {
        sendJson(res, 404, { ok: false, error: 'The CSV is not ready yet.' });
        return true;
      }
      let data;
      try { data = fs.readFileSync(job.csvPath); }
      catch (e) {
        sendJson(res, 410, { ok: false, error: 'The CSV file is no longer on disk.' });
        return true;
      }
      cors(res);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + job.csvName + '"',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      });
      res.end(data);
      return true;
    }
    if (req.method === 'GET' && !parts[3]) {
      sendJson(res, 200, { ok: true, job: job.snapshot() });
      return true;
    }
  }

  sendJson(res, 404, { ok: false, error: 'Unknown API route.' });
  return true;
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1')); }
  catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err && err.message ? err.message : String(err) });
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD, OPTIONS' });
    res.end('Method not allowed');
    return;
  }
  serveStatic(req, res, url.pathname);
});

function openApp(url) {
  if (config.noOpen || process.platform !== 'win32') return;
  try {
    const child = spawn('cmd', ['/c', 'start', '""', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (e) { /* the URL is printed either way */ }
}

server.on('error', err => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('\n  Port ' + config.port + ' is already in use.');
    console.error('  The activation checker is probably already running.');
    console.error('  Open http://' + config.host + ':' + config.port + '/ instead.\n');
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const url = 'http://' + config.host + ':' + config.port + '/';
  const p = playwrightStatus();
  console.log('');
  console.log('  AKS activation checker');
  console.log('  ' + url);
  console.log('  Supported brands: ' + (runner.listAdapters().map(a => a.label).join(', ') || 'none'));
  if (!p.dependencies) {
    console.log('');
    console.log('  Playwright is not installed yet.');
    console.log('  Close this window and run Start Activation Checker.bat again.');
  } else if (!p.browser) {
    console.log('');
    console.log('  Chromium is not installed yet.');
    console.log('  Close this window and run Start Activation Checker.bat again.');
  }
  console.log('');
  console.log('  Keep this window open while checking. Press Ctrl+C to stop.');
  console.log('');
  openApp(url);
});

function shutdown() {
  const active = runner.activeJob();
  if (active) active.stop();
  setTimeout(() => process.exit(0), 600);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
