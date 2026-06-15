// ── AUTH ──────────────────────────────────────────────────────────────────

async function doLogin() {
  const u = v('l-user'), p = v('l-pin');

  // Try local match (hardcoded users have PINs in S.users)
  let user = S.users.find(x => x.username === u && x.pin === p);

  // Fallback: verify against server (sheet users whose PINs are stored server-side)
  if (!user && S.sheetsUrl) {
    const res = await gasPost({ action: 'login', username: u, pin: p });
    if (res.ok && res.user) {
      user = res.user;
      // Merge full user (with PIN) into S.users for future lookups
      const idx = S.users.findIndex(x => x.id === user.id);
      if (idx >= 0) S.users[idx] = user;
      else S.users.push(user);
      saveUsers();
    }
  }

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
  document.documentElement.className = '';
  $('auth-screen').style.display = 'flex';
  $('app').style.display = 'none';
  $('l-user').value = '';
  $('l-pin').value = '';
}

function defPage() {
  if (S.cu.perms.emi)       return 'emi';
  if (S.cu.perms.loan)      return 'new-loan';
  if (S.cu.perms.allLoans)  return 'all-loans';
  if (S.cu.perms.approvals) return 'approvals';
  return 'emi';
}

document.addEventListener('DOMContentLoaded', async () => {
  $('l-pin').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  await fetchUsersFromSheets();
  const saved = localStorage.getItem('aks_user');
  if (saved) {
    const user = S.users.find(x => x.username === saved);
    // Only auto-restore if user has a PIN (hardcoded admin).
    // Sheet users re-enter their PIN on each page load (PINs are never stored in localStorage).
    if (user && user.pin) completeLogin(user);
  }
});
