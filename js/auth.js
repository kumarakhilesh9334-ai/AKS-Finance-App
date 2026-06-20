// ── AUTH ──────────────────────────────────────────────────────────────────

async function doLogin() {
  const u = v('l-user'), p = v('l-pin');

  // Try local match (only works if user was previously cached with PIN from prior login)
  let user = S.users.find(x => x.username === u && x.pin === p);

  // Fallback: verify against server
  let serverErr = '';
  if (!user && S.sheetsUrl) {
    const res = await gasPost({ action: 'login', username: u, pin: p });
    if (res.ok && res.user) {
      user = res.user;
      // Store session token for auto-restore on page refresh
      if (res.token) localStorage.setItem('aks_token', res.token);
      // Merge full user (with PIN) into S.users for future lookups
      const idx = S.users.findIndex(x => x.id === user.id);
      if (idx >= 0) S.users[idx] = user;
      else S.users.push(user);
      saveUsers();
    } else if (res && res.error) {
      serverErr = res.error;
    }
  }

  if (!user) {
    $('l-err').textContent = serverErr || 'Invalid username or PIN';
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
  restoreState();   // hydrate from cache for instant first paint
  buildNav();
  goTo(S.page || defPage());

  if (S.sheetsUrl) {
    fetchLoansFromSheets(true);
    fetchPendingFromSheets();
  }
}

function doLogout() {
  localStorage.removeItem('aks_user');
  localStorage.removeItem('aks_token');
  clearCache();
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
  if (S.cu.perms.allLoans)  return 'all-loans';
  if (S.cu.perms.emi)       return 'emi';
  if (S.cu.perms.loan)      return 'new-loan';
  if (S.cu.perms.approvals) return 'approvals';
  return 'all-loans';
}

document.addEventListener('DOMContentLoaded', async () => {
  $('l-pin').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  await fetchUsersFromSheets();

  // Try restoring session from token (no PIN re-entry needed)
  const token = localStorage.getItem('aks_token');
  if (token) {
    const res = await gasPost({ action: 'restoreSession', token });
    if (res.ok && res.user) {
      completeLogin(res.user);
      return;
    }
    // Token expired or invalid — clear it and show login
    localStorage.removeItem('aks_token');
  }

  // Fallback: restore from saved username (only if user has PIN cached locally)
  const saved = localStorage.getItem('aks_user');
  if (saved) {
    const user = S.users.find(x => x.username === saved);
    if (user && user.pin) completeLogin(user);
  }
});
