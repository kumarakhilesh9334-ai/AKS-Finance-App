// ── STATE ─────────────────────────────────────────────────────────────────
// Central data store for AKS Finance app.
// All modules read/write through this object.

const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbzyMrb-oU3s_MH1jROgYO7oQAyWP6BgXx9qsuxz25I4jIoqJpsgchEFsE_Cgf9OJnx5Zw/exec';
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
    const res  = await fetch(S.sheetsUrl + '?action=readUsers');
    const data = await res.json();
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

// ── CACHE ───────────────────────────────────────────────────────────────────
const CACHE_KEYS = ['sheetLoans','pending','revisedDates','approvedPartials'];

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
    if (restored) S._fullLoaded = true;
  } catch(e) {}
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
  _submittedEmis: {}, // local-only: { loanId_emiNum: true }
};

let pid = 100; // auto-increment for pending IDs

// ── SHARED HELPERS ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const v = id => $(id)?.value?.trim() || '';
const num = id => parseFloat($(id)?.value) || 0;
const fmt = n => n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN');

function showAlert(msg, type = 's') {
  $('alert-box').innerHTML = `<div class="alert al-${type}">${msg}</div>`;
  setTimeout(() => $('alert-box').innerHTML = '', 3500);
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
