// ── AUTH ──────────────────────────────────────────────────────────────────

async function doLogin() {
  const u = v('l-user'), p = v('l-pin');

  let user = null;
  let serverErr = '';

  // Always fetch from server for fresh permissions
  if (S.sheetsUrl) {
    const res = await gasPost({ action: 'login', username: u, pin: p });
    if (res.ok && res.user) {
      user = res.user;
      if (res.token) localStorage.setItem('aks_token', res.token);
      // Signed 30-day credential for reading the snapshot — not a session
      // token, and never readable from JavaScript on the Worker side.
      storeSnapshotToken(res.snapshotToken);
    } else if (res && res.error) {
      // Transport failures fall through to the local-match fallback below, so
      // they must not be worded like a credentials error.
      serverErr = res.transport ? "Couldn't reach the server — check your connection and try again." : res.error;
    }
  }

  // Fallback: local match if server unavailable
  if (!user) {
    user = S.users.find(x => x.username === u && x.pin === p);
  }

  if (!user) {
    $('l-err').textContent = serverErr || 'Invalid username or PIN';
    $('l-err').style.display = 'block';
    setTimeout(() => $('l-err').style.display = 'none', 3000);
    return;
  }

  // Merge into S.users and save
  const idx = S.users.findIndex(x => x.id === user.id);
  if (idx >= 0) S.users[idx] = user;
  else S.users.push(user);
  saveUsers();

  localStorage.setItem('aks_user', user.username);
  localStorage.setItem('aks_cu', JSON.stringify(user));
  completeLogin(user);
}

function completeLogin(user) {
  S.cu = user;
  migrateUserPerms();
  $('auth-screen').style.display = 'none';
  $('app').style.display = 'block';
  $('hdr-name').textContent = user.name;
  $('hdr-badge').innerHTML = `<span class="badge b-${user.role}">${user.role}</span>`;
  S.sheetLoans = [];
  S.selectedEmiLoanId = null;
  S.pending = [];
  // Fresh session → empty write history. Nothing done before login should
  // block anything after it.
  S._actionLog = {};
  // Must be set BEFORE goTo(), otherwise the all-loans page fires its partials
  // read using the cached snapshot's age — which after any gap longer than the
  // push interval says "stale" and sneaks one Google read past the gate.
  S._booting = true;
  restoreState();   // hydrate from cache for instant first paint
  buildNav();
  goTo(S.page || defPage());

  // First paint is done. snapshot.js now holds the decision: the five Google
  // boot reads run only if the Worker could not answer for them.
  if (S.sheetsUrl) scheduleBootRefresh();
  else S._booting = false;
}

function doLogout() {
  localStorage.removeItem('aks_user');
  localStorage.removeItem('aks_token');
  localStorage.removeItem('aks_cu');
  // The snapshot token outlives the session (30 days) — it must not outlive
  // the user pressing Sign out, or the next person at this browser could pull
  // the whole dataset without a PIN.
  localStorage.removeItem(SNAP_TOKEN_KEY);
  clearCache();
  S.cu = null;
  S.sheetLoans = [];
  S.pending = [];
  S.snapshotAt = 0;
  S.snapshotExpired = false;
  S.snapshotError = null;
  S._booting = false;
  // Session-scoped write history — never carries across users.
  S._actionLog = {};
  S._submittedEmis = {};
  renderDataAsOf();
  document.documentElement.className = '';
  $('auth-screen').style.display = 'flex';
  $('app').style.display = 'none';
  $('l-user').value = '';
  $('l-pin').value = '';
}

function defPage() {
  if (S.cu.perms.allLoans)  return 'all-loans';
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
    completeLogin(cachedUser);   // paints entirely from localStorage — 0 network
    // Verify the session in the background. restoreSession also re-mints the
    // snapshot token, so the snapshot refresh waits for it: a token that has
    // simply aged past 30 days gets renewed rather than reported as expired.
    const token = localStorage.getItem('aks_token');
    if (token) {
      // completeLogin already fired the snapshot (which renews its own token
      // on a 401), so this call only validates the session itself.
      gasPost({ action: 'restoreSession', token }, { priority: PRIORITY.session }).then(res => {
        if (res && !res.ok && res.error === 'Invalid or expired session') { doLogout(); return; }
        if (res && res.snapshotToken) storeSnapshotToken(res.snapshotToken);
      }).catch(() => {});
    }
    return;
  }

  // 2. No cached user — try token restore (backward compat for existing sessions)
  const token2 = localStorage.getItem('aks_token');
  if (token2) {
    const res = await gasPost({ action: 'restoreSession', token: token2 }, { priority: PRIORITY.session });
    if (res.ok && res.user) {
      localStorage.setItem('aks_cu', JSON.stringify(res.user));
      storeSnapshotToken(res.snapshotToken);
      completeLogin(res.user);
      return;
    }
    localStorage.removeItem('aks_token');
  }

  // 3. Show auth screen
  document.documentElement.className = '';
  fetchUsersFromSheets();
});
