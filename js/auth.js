// ── AUTH ──────────────────────────────────────────────────────────────────

// The PIN is a sign-in credential and nothing else. It goes to the server once,
// inside the body of the login POST, and comes back as a session token; from
// then on this device never stores it and never puts it in a URL (gasGet and
// gasPost send `S._token`). A stored PIN only survives until a token exists —
// see the migration below, which is what keeps already-signed-in users signed in.
function stripPin(u) {
  if (!u || typeof u !== 'object') return u;
  const { pin, ...rest } = u;
  return rest;
}

// `S.cu` keeps its PIN exactly while there is no token to replace it: that is
// the signal gasGet/gasPost use for the transitional fallback above.
function storedToken() {
  try { return localStorage.getItem('aks_token') || ''; } catch (e) { return ''; }
}

// Trades a PIN that is sitting in storage for a session token, then deletes the
// PIN — the only situation in which it is ever safe to remove. Returns true when
// the server confirmed the credentials. Never throws; on any failure the PIN
// stays where it is and the next boot tries again, so a device can never end up
// signed out with no way back in.
async function exchangeStoredPin(username, pin) {
  try {
    const res = await gasPost({ action: 'login', username, pin }, { priority: PRIORITY.session });
    if (!(res && res.ok && res.token)) return false;
    try { localStorage.setItem('aks_token', res.token); } catch (e) {}
    if (res.snapshotToken) storeSnapshotToken(res.snapshotToken);
    try {
      const cur = JSON.parse(localStorage.getItem('aks_cu') || '{}');
      delete cur.pin;
      localStorage.setItem('aks_cu', JSON.stringify(cur));
    } catch (e) {}
    S._token = res.token;
    if (S.cu) S.cu = stripPin(S.cu);
    return true;
  } catch (e) { return false; }
}

async function doLogin() {
  const u = v('l-user'), p = v('l-pin');

  let user = null;
  let serverErr = '';
  // True only when the SERVER accepted the credentials and returned a token.
  // That proof is what authorises deleting the PIN from storage.
  let gotToken = false;

  // Always fetch from server for fresh permissions
  if (S.sheetsUrl) {
    const res = await gasPost({ action: 'login', username: u, pin: p });
    if (res.ok && res.user) {
      user = res.user;
      if (res.token) { localStorage.setItem('aks_token', res.token); gotToken = true; }
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
  // Delete the PIN as soon as the server has confirmed us with a token. A local
  // match — the server was unreachable — keeps it, because that PIN is the only
  // credential that can mint a token on the next boot; dropping it there would
  // strand the device with nothing to authenticate with later.
  localStorage.setItem('aks_cu', JSON.stringify(gotToken ? stripPin(user) : user));
  completeLogin(user);
}

function completeLogin(user) {
  // One credential, one place: the token (when there is one) is what every
  // request now carries, so the in-memory copy of the user is stripped too.
  S.cu = storedToken() ? stripPin(user) : user;
  S._token = storedToken();
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
  S._token = '';
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
  // NOTE: no `.pin` in this condition on purpose. The PIN is deleted from
  // storage as soon as a session token exists (below), and a device that is
  // already signed in must keep being signed in after that happens.
  if (cachedUser && cachedUser.id) {
    // A record saved before the PIN was purged still carries one. If a token
    // already exists the PIN is simply redundant and goes; if it does not, the
    // PIN is exchanged for a token in the background and deleted only once the
    // server has confirmed it. Nothing waits on that exchange: until it lands
    // the app authenticates the old way (the transitional branch in gasGet),
    // so a slow or failed round trip costs nothing and never signs anyone out.
    if (cachedUser.pin) {
      if (storedToken()) {
        delete cachedUser.pin;
        try { localStorage.setItem('aks_cu', JSON.stringify(cachedUser)); } catch (e) {}
      } else {
        exchangeStoredPin(cachedUser.username, cachedUser.pin);   // fire and forget
      }
    }
    completeLogin(cachedUser);   // paints entirely from localStorage — 0 network
    // Verify the session in the background. restoreSession also re-mints the
    // snapshot token, so the snapshot refresh waits for it: a token that has
    // simply aged past 30 days gets renewed rather than reported as expired.
    const token = localStorage.getItem('aks_token');
    if (token) {
      // completeLogin already fired the snapshot (which renews its own token
      // on a 401), so this call only validates the session itself.
      gasPost({ action: 'restoreSession', token }, { priority: PRIORITY.session }).then(async res => {
        if (!(res && !res.ok && res.error === 'Invalid or expired session')) {
          if (res && res.snapshotToken) storeSnapshotToken(res.snapshotToken);
          return;
        }
        // The session record is gone, but this device still holds its PIN: it
        // was signed in before sessions replaced the PIN. Mint a fresh session
        // instead of throwing the user out. A migrated device has no PIN left
        // and falls through to the sign-in screen exactly as before.
        if (cachedUser.pin && await exchangeStoredPin(cachedUser.username, cachedUser.pin)) return;
        doLogout();
      }).catch(() => {});
    }
    return;
  }

  // 2. No cached user — try token restore (backward compat for existing sessions)
  const token2 = localStorage.getItem('aks_token');
  if (token2) {
    const res = await gasPost({ action: 'restoreSession', token: token2 }, { priority: PRIORITY.session });
    if (res.ok && res.user) {
      // stripPin is belt and braces: the script already hands back a
      // credential-less user, and localStorage must never hold a PIN.
      localStorage.setItem('aks_cu', JSON.stringify(stripPin(res.user)));
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
