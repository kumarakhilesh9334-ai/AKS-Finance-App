// ── AUTH ──────────────────────────────────────────────────────────────────
// Handles login, logout, and session display.

function doLogin() {
  const u = v('l-user'), p = v('l-pin');
  const user = S.users.find(x => x.username === u && x.pin === p);
  if (!user) {
    $('l-err').textContent = 'Invalid username or PIN';
    $('l-err').style.display = 'block';
    setTimeout(() => $('l-err').style.display = 'none', 3000);
    return;
  }
  S.cu = user;
  $('auth-screen').style.display = 'none';
  $('app').style.display = 'block';
  $('hdr-name').textContent = user.name;
  $('hdr-badge').innerHTML = `<span class="badge b-${user.role}">${user.role}</span>`;
  S.sheetLoans = []; // reset on each login
  S.selectedEmiLoanId = null;
  buildNav();
  goTo(S.page || defPage());
  // Fetch loans from Sheets in background after login
  if (S.sheetsUrl) fetchLoansFromSheets();
}

function doLogout() {
  S.cu = null;
  $('auth-screen').style.display = 'flex';
  $('app').style.display = 'none';
  $('l-user').value = '';
  $('l-pin').value = '';
}

function defPage() {
  return S.cu.role === 'admin' ? 'approvals' : (S.cu.perms.loan ? 'new-loan' : 'emi');
}

// Allow Enter key on PIN field to trigger login
document.addEventListener('DOMContentLoaded', () => {
  $('l-pin').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
});
