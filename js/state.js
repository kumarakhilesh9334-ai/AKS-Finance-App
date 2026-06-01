// ── STATE ─────────────────────────────────────────────────────────────────
// Central data store for AKS Financing app.
// All modules read/write through this object.

const S = {
  users: [
    { id: 'u1', username: 'AKS', pin: '0000', name: 'AKS (You)', role: 'admin', perms: { loan: true, emi: true } },
    { id: 'u2', username: 'agent1', pin: '1111', name: 'Agent One', role: 'agent', perms: { loan: true, emi: true } },
  ],
  loans: [],    // approved loan records
  emis: [],     // approved EMI records
  pending: [],  // submissions awaiting approval
  cu: null,     // currently logged-in user
  page: null,   // current active page
  sheetsUrl: localStorage.getItem('aks_sheets_url') || '', // Google Apps Script web app URL
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
  return 'P' + (++pid);
}
