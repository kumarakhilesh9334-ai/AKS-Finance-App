// ── STATE ─────────────────────────────────────────────────────────────────
// Central data store for AKS Financing app.
// All modules read/write through this object.

const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbzFE_aDkwxYUsB47VPWJGpDft4wvm_k2VqAz7oMRAdaNdNeTumb3VZ_vd50esW-vaEasQ/exec';
// ↑ Update this ONLY if you create a brand-new Apps Script deployment.
//   To update the script code without changing the URL:
//   Apps Script → Deploy → Manage deployments → Edit → New version → Deploy.

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
  sheetsUrl: SHEETS_URL,
  sheetLoans: [],
  selectedEmiLoanId: null,
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

function showLoader() { $('loader-overlay').classList.add('active'); }
function hideLoader() { $('loader-overlay').classList.remove('active'); }
