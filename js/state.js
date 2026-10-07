// ── STATE ─────────────────────────────────────────────────────────────────
// Central data store for AKS Finance app.
// All modules read/write through this object.

const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbzFE_aDkwxYUsB47VPWJGpDft4wvm_k2VqAz7oMRAdaNdNeTumb3VZ_vd50esW-vaEasQ/exec';
// const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbzyMrb-oU3s_MH1jROgYO7oQAyWP6BgXx9qsuxz25I4jIoqJpsgchEFsE_Cgf9OJnx5Zw/exec';
// ↑ Update this ONLY if you create a brand-new Apps Script deployment.
//   To update the script code without changing the URL:
//   Apps Script → Deploy → Manage deployments → Edit → New version → Deploy.

function loadUsers() {
  try {
    const saved = localStorage.getItem('aks_users');
    if (saved) { const u = JSON.parse(saved); if (Array.isArray(u) && u.length) return u; }
  } catch(e) {}
  return [];
}

function saveUsers() {
  localStorage.setItem('aks_users', JSON.stringify(S.users.map(({ pin, ...u }) => u)));
}

// Ensure all users have the submit permission (default: admins=true, others=false)
function migrateUserPerms() {
  S.users = S.users.map(u => {
    if (!u.perms) u.perms = {};
    if (u.perms.submit === undefined) u.perms.submit = u.role === 'admin';
    if (u.perms.stock === undefined)  u.perms.stock  = u.role === 'admin';
    return u;
  });
  if (S.cu) {
    if (!S.cu.perms) S.cu.perms = {};
    if (S.cu.perms.submit === undefined) S.cu.perms.submit = S.cu.role === 'admin';
    if (S.cu.perms.stock === undefined)  S.cu.perms.stock  = S.cu.role === 'admin';
  }
}

async function fetchUsersFromSheets() {
  if (!S.sheetsUrl) return;
  try {
    // Routed through gasGet instead of a bare fetch: this was the only boot
    // request with no retry, no in-flight dedupe and no queue slot. It now
    // retries transient 404s and joins the concurrency queue like the rest.
    const data = await gasGet('readUsers', {}, { priority: PRIORITY.users });
    if (data.ok && Array.isArray(data.users)) {
      S.users = data.users;
      migrateUserPerms();
      saveUsers();
      if (S.cu) {
        const fresh = S.users.find(u => u.id === S.cu.id);
        if (fresh) {
          S.cu.role  = fresh.role;
          S.cu.perms = fresh.perms;
          try { localStorage.setItem('aks_cu', JSON.stringify(S.cu)); } catch(e) {}
          refreshNav();
        }
      }
    }
  } catch(e) {
    console.warn('Could not fetch users from sheet, using local:', e.message);
  }
}

// ── REQUEST PRIORITY ──────────────────────────────────────────────────────
// Lower number = admitted to the Apps Script queue first. The app used to fire
// every boot request at once and let Google sort it out; giving the boot burst
// an explicit order (and a hard concurrency cap) keeps a card click or a user
// write from waiting behind a background refresh.
const PRIORITY = {
  detail:   0,   // readLoanDetail  — the user is staring at this card
  slim:     1,   // readLoansSlim   — boots the card list
  session:  2,   // restoreSession  — must land before anything needs auth
  full:     3,   // readAllLoans
  pending:  4,   // readPending
  revDates: 5,   // readRevisedDates
  partials: 6,   // readApprovedPartials
  users:    7,   // readUsers
  push:     9,   // pushSnapshotNow — 15 s, admitted last so a card click or a
                 //                 write never queues behind it (1 of 2 slots
                 //                 is held for the duration; the other stays free)
};
// Writes and lookups that are not named above.
const PRIORITY_WRITE = 1;
const PRIORITY_DEFAULT = 5;

// ── CACHE ───────────────────────────────────────────────────────────────────
// `snapshotAt` is the generatedAt of the last snapshot we applied — it is what
// the "Data as of" strip renders, and it must survive a reload so the strip is
// honest before any network call has happened.
const CACHE_KEYS = ['sheetLoans','pending','revisedDates','approvedPartials','snapshotAt'];

function cacheState() {
  try {
    CACHE_KEYS.forEach(k => {
      const v = S[k];
      if (v !== undefined && v !== null) localStorage.setItem('aks_cache_'+k, JSON.stringify(v));
    });
  } catch(e) { /* quota exceeded */ }
}

function restoreState() {
  try {
    let restored = false;
    CACHE_KEYS.forEach(k => {
      const s = localStorage.getItem('aks_cache_'+k);
      if (s) { const v = JSON.parse(s); if (v !== null) { S[k] = v; restored = true; } }
    });
    const firstLoan = Array.isArray(S.sheetLoans) ? S.sheetLoans[0] : null;
    S._fullLoaded = restored && !!firstLoan && !firstLoan._slim;
  } catch(e) {}
  // Defined in snapshot.js, which loads after this file — but only ever runs
  // after every script has parsed, so the guard is belt-and-braces.
  if (typeof renderDataAsOf === 'function') renderDataAsOf();
}

function clearCache() {
  CACHE_KEYS.forEach(k => localStorage.removeItem('aks_cache_'+k));
}

const S = {
  users: loadUsers(),
  loans: [],    // approved loan records
  emis: [],     // approved EMI records
  pending: [],  // submissions awaiting approval
  approvedPartials: [], // approved partial payments
  cu: null,     // currently logged-in user
  page: null,   // current active page
  sheetsUrl: SHEETS_URL,
  sheetLoans: [],
  selectedEmiLoanId: null,
  revisedDates: [],
  showRevisedView: false,
  showOverviewRevised: false,
  showOverviewPartials: false,
  _fullLoaded: false,
  // Bumped every time full (non-slim) loan rows land — from readAllLoans or
  // from a snapshot. A readLoansSlim that started before the bump must not
  // paint over them: slim rows are a strict subset and would push every card
  // click back onto a per-loan round-trip.
  _fullStamp: 0,
  snapshotAt: 0,       // generatedAt of the applied snapshot (ms epoch)
  snapshotExpired: false, // the Worker rejected our token — nothing to renew with
  snapshotError: null, // last refreshSnapshot() failure reason, for the strip
  lastWriteAt: 0,      // ms epoch of our last successful write; a snapshot built
                       // before this must never paint over what we just saved
  _submittedEmis: {}, // local-only: { loanId_emiNum: true }
  _loadingLoans: false, // local-only: true while a loan fetch is genuinely running
  // True from login until snapshot.js has decided whether the five Google boot
  // reads are still needed. Navigation must not fire one in that window — the
  // decision would cancel it a second later.
  _booting: false,
  _actionLog: {},       // local-only, session-scoped: { key: 'done'|'unconfirmed'|'failed' }
                        // Never persisted — a page refresh falls back to the server
                        // as the source of truth.
};

let pid = 100; // auto-increment for pending IDs

// ── SHARED HELPERS ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const v = id => $(id)?.value?.trim() || '';
const num = id => parseFloat($(id)?.value) || 0;
const fmt = n => n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN');

let _alertTimer = null;
function showAlert(msg, type = 's') {
  // Errors open a pop-up dialog instead of the banner strip — impossible to miss.
  if (type === 'e') { showErrorModal(msg); return; }
  if (_alertTimer) { clearTimeout(_alertTimer); _alertTimer = null; }
  const box = $('alert-box');
  box.innerHTML = `<div class="alert al-${type}" onclick="dismissAlert()">${msg}</div>`;
  _alertTimer = setTimeout(() => { if ($('alert-box')) $('alert-box').innerHTML = ''; _alertTimer = null; }, 3500);
}

// Tap anywhere on the toast to dismiss it immediately.
function dismissAlert() {
  if (_alertTimer) { clearTimeout(_alertTimer); _alertTimer = null; }
  if ($('alert-box')) $('alert-box').innerHTML = '';
}

// Pop-up error dialog (created on demand, styled to match the app).
function showErrorModal(msg) {
  let m = document.getElementById('error-modal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'error-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px';
    m.innerHTML =
      '<div role="dialog" style="background:#fff;border-radius:16px;width:100%;max-width:360px;padding:22px;box-shadow:0 8px 32px rgba(0,0,0,0.25);text-align:center">' +
        '<div style="width:46px;height:46px;margin:0 auto 10px;border-radius:50%;background:#FCEBEB;display:flex;align-items:center;justify-content:center;font-size:22px">⚠️</div>' +
        '<div style="font-size:14px;font-weight:600;color:#A32D2D;margin-bottom:6px">Something went wrong</div>' +
        '<div id="error-modal-msg" style="font-size:13px;color:#333;line-height:1.45;word-break:break-word"></div>' +
        '<button class="btn" style="width:100%;margin-top:16px;background:#A32D2D;color:#fff;border:none;padding:10px 0;border-radius:8px;font-weight:600;cursor:pointer" onclick="closeErrorModal()">OK</button>' +
      '</div>';
    m.addEventListener('click', e => { if (e.target === m) closeErrorModal(); });
    document.body.appendChild(m);
  }
  const msgEl = m.querySelector('#error-modal-msg');
  if (msgEl) msgEl.textContent = String(msg);   // textContent — server messages can't inject HTML
  m.style.display = 'flex';
}

function closeErrorModal() {
  const m = document.getElementById('error-modal');
  if (m) m.style.display = 'none';
}

function nextPid() {
  return 'P' + Date.now() + '_' + (++pid);
}

function showLoader() {
  const existing = document.getElementById('loader-overlay');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'loader-overlay';
  el.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(83,74,183,0.2);display:flex;align-items:center;justify-content:center;z-index:99999';
  el.innerHTML = '<div style="background:#534AB7;color:#fff;padding:16px 24px;border-radius:12px;font-size:16px;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,0.2)">⏳ Loading…</div>';
  document.body.appendChild(el);
}
function hideLoader() {
  const el = document.getElementById('loader-overlay');
  if (el) el.remove();
}
