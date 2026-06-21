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
  localStorage.setItem('aks_cu', JSON.stringify(user));
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
  localStorage.removeItem('aks_cu');
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

  // 1. Instant restore from cached user (no network) — renders skeleton + cached cards immediately
  let cachedUser = null;
  try { const s = localStorage.getItem('aks_cu'); if (s) cachedUser = JSON.parse(s); } catch(e) {}
  if (cachedUser && cachedUser.id && cachedUser.pin) {
    completeLogin(cachedUser);
    // Verify session token in background — if invalid, log out
    const token = localStorage.getItem('aks_token');
    if (token) {
      gasPost({ action: 'restoreSession', token }).then(res => {
        if (!res.ok || !res.user) { showAlert('Session expired. Please login again.', 'e'); doLogout(); }
      });
    }
    // Refresh users in background
    fetchUsersFromSheets();
    return;
  }

  // 2. No cached user — try token restore (backward compat for existing sessions)
  const token2 = localStorage.getItem('aks_token');
  if (token2) {
    const res = await gasPost({ action: 'restoreSession', token2 });
    if (res.ok && res.user) {
      localStorage.setItem('aks_cu', JSON.stringify(res.user));
      completeLogin(res.user);
      fetchUsersFromSheets();
      return;
    }
    localStorage.removeItem('aks_token');
  }

  // 3. Show auth screen
  document.documentElement.className = '';
  fetchUsersFromSheets();
});
