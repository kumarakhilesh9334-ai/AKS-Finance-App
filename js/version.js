// ── APP VERSION ─────────────────────────────────────────────────────────────
// APP_VERSION is the ONE number shown in the header. Bump it by hand when a
// release changes behaviour the user can see. It is not derived from anything:
// there is no build step in this project, so this constant is the source of
// truth.
//
// Do not confuse it with the other two counters, which are cache busters:
//   index.html  <script src="js/stock.js?v=28">  per-file browser cache key
//   sw.js       CACHE_NAME = 'aks-finance-v29'    service-worker cache bucket
// They change more often than APP_VERSION and are listed in the dialog below so
// a device can prove which files it actually loaded.

const APP_VERSION = '1.4.0';
const APP_RELEASED = '14-Nov-2026';

function initAppVersion() {
  const el = $('app-version');
  if (!el) return;
  el.textContent = 'v' + APP_VERSION;
  el.title = 'App version — tap for build details';
}

function _verDisplayMode() {
  const modes = ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay', 'browser'];
  for (let i = 0; i < modes.length; i++) {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: ' + modes[i] + ')').matches) return modes[i];
    } catch (e) { /* ignore */ }
  }
  return 'unknown';
}

// Read the ?v= values straight out of the DOM. This is what the running page
// really loaded, not what index.html says on the server.
function _verLoadedAssets() {
  const out = [];
  const nodes = document.querySelectorAll('script[src], link[rel="stylesheet"]');
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const raw = n.tagName.toLowerCase() === 'link'
      ? n.getAttribute('href')
      : n.getAttribute('src');
    if (!raw || raw.indexOf('?v=') === -1) continue;
    out.push(raw.substring(raw.lastIndexOf('/') + 1));
  }
  return out;
}

async function showAppVersion() {
  const modal = $('app-version-modal');
  const box = $('ver-info');
  if (!modal || !box) return;

  let sw = 'not registered';
  try {
    if (window.isSecureContext === false) {
      // Plain http:// on a LAN address is not a secure context, so the browser
      // refuses to register a service worker at all. Say so, instead of the
      // misleading "registered" text below.
      sw = 'unavailable (http, not a secure context)';
    } else if (navigator.serviceWorker) {
      sw = navigator.serviceWorker.controller ? 'active (controlling this page)' : 'registered, not controlling yet';
    }
  } catch (e) { /* ignore */ }

  let cachesTxt = '';
  try {
    if (window.caches && caches.keys) cachesTxt = (await caches.keys()).join(', ');
  } catch (e) { /* ignore */ }

  const rows = [
    ['App version', 'v' + APP_VERSION],
    ['Released', APP_RELEASED],
    ['Display mode', _verDisplayMode()],
    ['Service worker', sw],
    ['SW cache', cachesTxt || 'none'],
    ['Loaded files', _verLoadedAssets().join(', ') || 'none'],
    ['Where', (location.origin || '') + (location.pathname || '')],
    ['Platform', navigator.userAgent || 'unknown'],
  ];

  box.innerHTML = rows.map(r =>
    '<div class="ver-row"><span class="ver-k">' + _verEsc(r[0]) + '</span>'
    + '<span class="ver-v">' + _verEsc(r[1]) + '</span></div>'
  ).join('');

  modal.style.display = 'flex';
}

function _verEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function closeAppVersion() {
  const modal = $('app-version-modal');
  if (modal) modal.style.display = 'none';
}

// Lets the user send the exact build details when something misbehaves.
function copyAppVersion() {
  const box = $('ver-info');
  if (!box) return;
  const text = Array.prototype.map.call(box.querySelectorAll('.ver-row'), row => {
    const k = row.querySelector('.ver-k');
    const val = row.querySelector('.ver-v');
    return (k ? k.textContent : '') + ': ' + (val ? val.textContent : '');
  }).join('\n');
  const done = msg => { if (typeof showAlert === 'function') showAlert(msg, 's'); };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done('Version info copied.')).catch(() => done('Could not copy version info.'));
      return;
    }
  } catch (e) { /* fall through */ }
  done('Could not copy version info.');
}

try { initAppVersion(); } catch (e) { /* header not ready yet */ }
