// ── AUTH ──────────────────────────────────────────────────────────────────

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
  S.sheetLoans = [];
  S.selectedEmiLoanId = null;
  S.pending = [];
  buildNav();
  goTo(S.page || defPage());

  if (S.sheetsUrl) {
    // Fetch both in parallel — whichever finishes first re-renders its tab
    fetchLoansFromSheets(true);   // force=true: always fetch fresh on login
    fetchPendingFromSheets();
  }
}

function doLogout() {
  S.cu = null;
  S.sheetLoans = [];
  S.pending = [];
  $('auth-screen').style.display = 'flex';
  $('app').style.display = 'none';
  $('l-user').value = '';
  $('l-pin').value = '';
}

function defPage() {
  return S.cu.role === 'admin' ? 'approvals' : (S.cu.perms.loan ? 'new-loan' : 'emi');
}

document.addEventListener('DOMContentLoaded', () => {
  $('l-pin').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
});
