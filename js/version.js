// ── APP VERSION ─────────────────────────────────────────────────────────────
// APP_VERSION is the ONE number shown in the header. Bump it by hand when a
// release changes behaviour the user can see. It is not derived from anything:
// there is no build step in this project, so this constant is the source of
// truth.
//
// Do not confuse it with the other two counters, which are cache busters:
//   index.html  <script src="js/stock.js?v=23">  per-file browser cache key
//   sw.js       CACHE_NAME = 'aks-finance-v15'    service-worker cache bucket
// They change more often than APP_VERSION and are listed in the dialog below so
// a device can prove which files it actually loaded.

const APP_VERSION = '1.2.2';
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

function _verCheckMode() {
  if (typeof _stockActivationHref !== 'function') return 'not loaded';
  const mode = typeof _stockCheckMode === 'function' ? _stockCheckMode() : 'auto';
  const href = _stockActivationHref('https://in.nothing.tech/pages/imei');
  if (!href) return mode + ' -> no navigation (copy only)';
  if (href.indexOf('intent://') === 0) {
    const pkg = typeof _stockCheckPkg === 'function' ? _stockCheckPkg() : '?';
    const act = typeof _stockCheckActivity === 'function' ? _stockCheckActivity() : '';
    return mode + ' -> ' + pkg + (act ? ' pinned' : '');
  }
  const kind = href.indexOf('android-app://') === 0 ? 'android-app://' : 'normal link';
  return mode + ' -> ' + kind;
}

// The mode selector lives in the version dialog so the Check behaviour can be
// tested on the device without shipping a new build.
function _verFillModeSelect() {
  const sel = $('ver-mode-select');
  if (!sel || typeof _STOCK_CHECK_MODES === 'undefined') return;
  const mode = typeof _stockCheckMode === 'function' ? _stockCheckMode() : 'auto';
  sel.innerHTML = _STOCK_CHECK_MODES.map(m =>
    '<option value="' + _verEsc(m) + '"' + (m === mode ? ' selected' : '') + '>'
    + _verEsc(_STOCK_CHECK_MODE_LABELS[m] || m) + '</option>'
  ).join('');
}

// Target browser for 'other-browser'. A <datalist> gives the common packages as
// suggestions while still allowing any package name to be typed. The optional
// activity field pins the launch to one activity, which removes the chooser.
function _verFillPkgInput() {
  const input = $('ver-pkg-input');
  const list = $('ver-pkg-list');
  const act = $('ver-act-input');
  if (typeof _STOCK_BROWSER_PKGS === 'undefined') return;
  if (list) {
    list.innerHTML = _STOCK_BROWSER_PKGS.map(p =>
      '<option value="' + _verEsc(p[1]) + '">' + _verEsc(p[0]) + '</option>'
    ).join('');
  }
  if (input && !input.value) {
    input.value = typeof _stockCheckPkg === 'function' ? _stockCheckPkg() : '';
  }
  if (act) {
    // Dialog opening is never mid-typing, so sync it from storage outright.
    act.value = typeof _stockCheckActivity === 'function' ? _stockCheckActivity() : '';
    // Placeholder shows the known activity for the chosen package, so it can be
    // typed in without guessing if a chooser still appears.
    const savedPkg = typeof _stockCheckPkg === 'function' ? _stockCheckPkg() : '';
    const hint = typeof _stockActivityHint === 'function'
      ? _stockActivityHint(savedPkg) : '';
    act.placeholder = hint || 'pin the browser\'s activity';
  }
}

function _verRefreshModeRow() {
  const now = $('ver-mode-now');
  const test = $('ver-test-link');
  const pkgRow = $('ver-pkg-row');
  if (typeof _stockActivationHref !== 'function') return;
  const href = _stockActivationHref('https://in.nothing.tech/pages/imei');
  const isAppScheme = href.indexOf('intent://') === 0 || href.indexOf('android-app://') === 0;
  const mode = typeof _stockCheckMode === 'function' ? _stockCheckMode() : 'auto';

  if (now) {
    now.textContent = !href ? 'no link' : isAppScheme ? (href.split(':')[0] + '://') : 'normal link';
  }
  // The package field is only meaningful for the other-browser hand-off.
  if (pkgRow) pkgRow.style.display = mode === 'other-browser' ? '' : 'none';
  // Keep the optional activity pin in step with whichever package is selected.
  // The pkg field is also rewritten from storage so a rejected value snaps back
  // to the default instead of sitting there as if it had been accepted.
  const actInput = $('ver-act-input');
  const pkgInput = $('ver-pkg-input');
  const savedPkg = typeof _stockCheckPkg === 'function' ? _stockCheckPkg() : '';
  if (pkgInput && mode === 'other-browser' && savedPkg) pkgInput.value = savedPkg;
  if (actInput) {
    // Only seed the field when it is empty: never overwrite what is being typed.
    if (!actInput.value && typeof _stockCheckActivity === 'function') {
      actInput.value = _stockCheckActivity();
    }
    const hint = typeof _stockActivityHint === 'function' ? _stockActivityHint(savedPkg) : '';
    actInput.placeholder = hint || 'pin the browser\'s activity';
  }

  if (test) {
    if (!href) {
      // Copy-only mode has no link to test. Disable rather than pretend.
      test.removeAttribute('href');
      test.removeAttribute('target');
      test.removeAttribute('rel');
      test.style.opacity = '0.45';
      test.style.pointerEvents = 'none';
      test.textContent = 'No link in this mode';
    } else {
      test.style.opacity = '';
      test.style.pointerEvents = '';
      test.textContent = 'Test link (Nothing page)';
      test.setAttribute('href', href);
      if (isAppScheme) {
        test.removeAttribute('target');
        test.removeAttribute('rel');
      } else {
        test.setAttribute('target', '_blank');
        test.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }
  // Keep the summary row in sync with the selector without rebuilding the
  // whole list (which would reset the select's focus while it is open).
  const rows = document.querySelectorAll('#ver-info .ver-row');
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i] || !rows[i].querySelector) continue;
    const k = rows[i].querySelector('.ver-k');
    const val = rows[i].querySelector('.ver-v');
    if (k && val && k.textContent === 'Check link mode') val.textContent = _verCheckMode();
  }
}

async function showAppVersion() {
  const modal = $('app-version-modal');
  const box = $('ver-info');
  if (!modal || !box) return;

  _verFillModeSelect();
  _verFillPkgInput();
  _verRefreshModeRow();

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
    ['Check link mode', _verCheckMode()],
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
