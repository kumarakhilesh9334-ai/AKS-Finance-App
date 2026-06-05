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
  localStorage.setItem('aks_user', user.username);
  completeLogin(user);
}

function completeLogin(user) {
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
    fetchLoansFromSheets(true);
    fetchPendingFromSheets();
  }
}

function doLogout() {
  localStorage.removeItem('aks_user');
  S.cu = null;
  S.sheetLoans = [];
  S.pending = [];
  $('auth-screen').style.display = 'flex';
  $('app').style.display = 'none';
  $('l-user').value = '';
  $('l-pin').value = '';
}

function defPage() {
  if (S.cu.perms.loan)      return 'new-loan';
  if (S.cu.perms.emi)       return 'emi';
  if (S.cu.perms.allLoans)  return 'all-loans';
  if (S.cu.perms.approvals) return 'approvals';
  return 'my-subs';
}

document.addEventListener('DOMContentLoaded', () => {
  $('l-pin').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  const saved = localStorage.getItem('aks_user');
  if (saved) {
    const user = S.users.find(x => x.username === saved);
    if (user) completeLogin(user);
  }
});
