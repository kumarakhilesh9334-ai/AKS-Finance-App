// ── SNAPSHOT ────────────────────────────────────────────────────────────────
// Three layers, fastest first:
//   0. localStorage          painted synchronously by restoreState()  — 0 ms
//   1. Cloudflare snapshot   rebuilt by Apps Script every 5 min        — ~0.3 s
//   2. Apps Script API       authoritative; writes and ↻ Refresh use it
//
// The snapshot is PIN-gated. The Worker refuses to hand it out without a signed
// token, so the URL on its own is worthless — sharing or leaking it exposes
// nothing. A token is minted on login, renews on every restoreSession, expires
// after 30 days, and dies within 5 minutes if the Users sheet is edited.

// Worker URL. Empty string = snapshot disabled: the app behaves exactly as it
// did before this file existed (localStorage + Apps Script API only).
// Set this after you create the Worker.
const SNAP_URL = 'https://aks-finance.kumarakhilesh9334.workers.dev/';

const SNAP_TOKEN_KEY = 'aks_snapshot_token';

function storeSnapshotToken(t) {
  if (!t) return;
  try { localStorage.setItem(SNAP_TOKEN_KEY, String(t)); } catch (e) {}
}
function getSnapshotToken() {
  try { return localStorage.getItem(SNAP_TOKEN_KEY); } catch (e) { return null; }
}

// ── Apply ───────────────────────────────────────────────────────────────────
// Writes into exactly the fields restoreState() populates, so every existing
// renderer keeps working untouched. Returns false when the snapshot was
// rejected (malformed, or built before our last write) — in that case nothing
// on screen changes at all.
function applySnapshot(snap) {
  if (!snap || typeof snap.generatedAt !== 'number' || !snap.data) return false;

  // A snapshot built before the most recent write must never paint over data
  // we already know is newer. Without this, a write followed by a snapshot
  // fetch would silently roll the screen back to the pre-write state.
  if (S.lastWriteAt && snap.generatedAt <= S.lastWriteAt) return false;

  const d = snap.data || {};
  const full  = Array.isArray(d.loans) ? d.loans : [];
  const slim  = Array.isArray(d.loans_slim) ? d.loans_slim : [];
  const loans = full.length ? full : slim;

  if (loans.length) {
    // applyLoanList refuses an empty-over-nonempty overwrite on purpose.
    applyLoanList(loans);
    S._fullLoaded = full.length > 0;
    if (full.length) S._fullStamp++;   // slim reads must not paint over this
  }

  if (Array.isArray(d.pending))      S.pending = d.pending;
  if (Array.isArray(d.revisedDates)) S.revisedDates = d.revisedDates;
  if (Array.isArray(d.partials))     S.approvedPartials = d.partials;

  if (Array.isArray(d.users) && d.users.length) {
    // Defensive: the server already strips PINs before pushing, but a snapshot
    // is data from outside this page — strip again on the way in rather than
    // trust it.
    S.users = d.users.map(({ pin, ...u }) => u);
    migrateUserPerms();
    saveUsers();
    if (S.cu) {
      const fresh = S.users.find(u => u.id === S.cu.id);
      if (fresh) {
        S.cu.role  = fresh.role;
        S.cu.perms = fresh.perms;
        try { localStorage.setItem('aks_cu', JSON.stringify(S.cu)); } catch (e) {}
        if (typeof refreshNav === 'function') refreshNav();
      }
    }
  }

  // Stashed for the modules that read them; those modules pick these up on
  // their next load without needing to know a snapshot exists.
  if (d.stock !== undefined)     S.snapStock = d.stock;
  if (d.config !== undefined)    S.snapConfig = d.config;
  if (d.templates !== undefined) S.snapTemplates = d.templates;

  S.snapshotAt = snap.generatedAt;
  S.snapshotExpired = false;
  S.snapshotError = null;

  // Persist through the normal cache path, so the NEXT page load paints this
  // whole screen from localStorage with no network call at all.
  cacheState();
  renderDataAsOf();

  rerenderActiveTab();
  if (typeof renderApprovals === 'function') {
    renderApprovals($('appr-search') ? $('appr-search').value : '');
  }
  refreshNav();
  return true;
}

// ── Fetch ───────────────────────────────────────────────────────────────────
async function fetchSnapshotOnce() {
  const token = getSnapshotToken();
  if (!SNAP_URL) return { ok: false, reason: 'disabled' };
  if (!token)    return { ok: false, reason: 'no-token' };
  let res;
  try {
    res = await fetch(SNAP_URL, {
      headers: { Authorization: 'Bearer ' + token },
      cache: 'no-store',
    });
  } catch (e) {
    return { ok: false, reason: 'transport' };
  }
  // 401 = bad signature, expired, or the epoch moved (a PIN/user changed).
  if (res.status === 401) return { ok: false, reason: 'unauthorized' };
  if (!res.ok) return { ok: false, reason: 'http' + res.status };
  try {
    return { ok: true, snap: await res.json() };
  } catch (e) {
    return { ok: false, reason: 'bad-json' };
  }
}

// A 401 may just mean the 30-day token lapsed on a device that is otherwise
// signed in. restoreSession re-mints one, so try that before giving up.
// Deduped: the boot path and a 401 must not fire two restores at once.
let _renewP = null;
function renewSnapshotToken() {
  if (_renewP) return _renewP;
  const session = localStorage.getItem('aks_token');
  if (!session || !S.sheetsUrl) return Promise.resolve(false);
  _renewP = gasPost({ action: 'restoreSession', token: session },
                    { priority: PRIORITY.session })
    .then(res => {
      _renewP = null;
      if (res && res.ok && res.snapshotToken) { storeSnapshotToken(res.snapshotToken); return true; }
      return false;
    })
    .catch(() => { _renewP = null; return false; });
  return _renewP;
}

let _snapRefreshP = null;
let _snapRetries = 0;

// A 401 right after setup usually means the 5-minute trigger has not produced
// its first snapshot yet (the Worker's epoch is still empty), so retry a few
// times before declaring anything broken. Cheap: three extra fetches over
// four minutes, and they stop the moment one succeeds.
const SNAP_RETRY_DELAY_MS = 90000;
const SNAP_MAX_RETRIES = 3;

function refreshSnapshot() {
  if (!SNAP_URL) return Promise.resolve({ ok: false, reason: 'disabled' });
  if (_snapRefreshP) return _snapRefreshP;
  _snapRefreshP = (async () => {
    let r = await fetchSnapshotOnce();
    if (!r.ok && (r.reason === 'unauthorized' || r.reason === 'no-token')) {
      if (await renewSnapshotToken()) r = await fetchSnapshotOnce();
    }
    if (r.ok) {
      applySnapshot(r.snap);
      _snapRetries = 0;
    } else {
      // Keep the reason: the strip reports it, and it is the one fact needed
      // to tell "not published yet" from "wrong secret" from "network down".
      S.snapshotError = r.reason;
      if (r.reason === 'unauthorized') S.snapshotExpired = true;
      console.warn('[snapshot] refresh failed:', r.reason);
      renderDataAsOf();
      if (r.reason === 'unauthorized' && _snapRetries < SNAP_MAX_RETRIES) {
        _snapRetries++;
        setTimeout(() => { _snapRefreshP = null; refreshSnapshot(); }, SNAP_RETRY_DELAY_MS);
      }
    }
    _snapRefreshP = null;
    return r;
  })();
  return _snapRefreshP;
}

// Plain-English (and developer-readable) text for each way the fetch can fail.
// This used to say "sign out and sign in" — wrong advice, since the failure is
// between the app and the Worker, not between the app and Google.
const SNAP_ERR_TEXT = {
  unauthorized:  '⚠ Snapshot access rejected (401) — data shown may be out of date',
  'no-token':    '⚠ No snapshot access yet — sign in again',
  transport:     "⚠ Can't reach the snapshot server — showing saved data",
  'bad-json':    '⚠ Snapshot server sent something unreadable',
  disabled:      '',
};
function snapErrText(reason) {
  if (reason && reason.indexOf('http') === 0) {
    return '⚠ Snapshot server error (' + reason.slice(4) + ') — data shown may be out of date';
  }
  return SNAP_ERR_TEXT[reason] || '⚠ Snapshot not refreshing — data shown may be out of date';
}

// ── Boot read gate ─────────────────────────────────────────────────────────
// Boot used to fire five Google reads on every page load — readAllLoans,
// readRevisedDates, readPending, readApprovedPartials, readUsers — even when
// the snapshot had just painted the same rows. The snapshot now gets first
// refusal: those five run only if the Worker could not answer for us.
//
// The decision is made AFTER the snapshot attempt, never from the cached
// timestamp. The localStorage timestamp records when *we* last applied one, so
// after a long absence it under-reports how fresh the Worker actually is — the
// trigger has been repushing every 10 minutes the whole time. Deciding from the
// cache would have fired all five reads on every ordinary app open.
const SNAP_FRESH_MS = 10 * 60 * 1000;   // matches createSnapshotTrigger()'s interval
const BOOT_DECIDE_MS = 8000;            // safety net if restoreSession hangs

function snapshotIsFresh() {
  if (!SNAP_URL) return false;
  if (S.snapshotExpired || S.snapshotError) return false;
  if (!S.snapshotAt) return false;
  if (S.lastWriteAt && S.snapshotAt <= S.lastWriteAt) return false;
  if (Date.now() - S.snapshotAt > SNAP_FRESH_MS) return false;
  // Skipping a read is only safe while its rows are actually on screen — a
  // fresh timestamp over an empty card list would leave nothing rendered and
  // no retry armed.
  if (!S._fullLoaded || !Array.isArray(S.sheetLoans) || !S.sheetLoans.length) return false;
  if (!Array.isArray(S.users) || !S.users.length) return false;
  return true;
}

let _bootDecided = false;

// Called once per login, right after first paint. The snapshot gets the first
// chance to answer; the Google reads follow only if it cannot.
function scheduleBootRefresh() {
  _bootDecided = false;
  S._booting = true;
  if (!S.sheetsUrl || !S.cu) { _bootDecided = true; S._booting = false; return; }
  const decide = () => maybeBootRefresh();
  refreshSnapshot().then(decide, decide);
  // Safety net: a hung restoreSession must not leave the screen on cache with
  // nothing running and no retry armed.
  setTimeout(decide, BOOT_DECIDE_MS);
}

function maybeBootRefresh() {
  if (_bootDecided || !S.sheetsUrl || !S.cu) return;
  _bootDecided = true;
  S._booting = false;
  if (snapshotIsFresh()) return;   // the snapshot already told us everything
  fetchLoansFromSheets(true);
  fetchPendingFromSheets();
  fetchUsersFromSheets();
}

// ── Manual refresh (the "Data as of" strip) ────────────────────────────────
// The strip is the app's only refresh control. It deliberately does NOT call
// readAllLoans / readPending / readUsers / readRevisedDates / readApprovedPartials:
// it asks the sheet to rebuild the snapshot, the sheet does all of those reads
// inside pushSnapshot() and ships the result to the Worker, and only then does
// this tab read anything — from the Worker. Same data, one path, and Google is
// never touched directly by a refresh.
//
// Cost is ~15 s (8 sources, ~93 columns). The sheet floors pushes at 30 s, so
// mashing the strip — or ten people doing it at once — cannot burn the 5400 s
// Apps Script budget; a throttled request comes straight back and we simply
// read whatever the Worker already holds.
let _stripBusy = false;

async function stripRefresh() {
  if (_stripBusy) return;
  if (!SNAP_URL || !S.sheetsUrl || !S.cu) return;
  _stripBusy = true;
  renderDataAsOf();
  try {
    const r = await gasPost({ action: 'pushSnapshotNow' },
                            { priority: PRIORITY.push });
    if (!r || !r.ok) throw new Error((r && r.error) || 'the sheet could not rebuild the snapshot');
    // Discard any fetch that started before the push landed, or we would
    // de-duplicate onto a promise for pre-push data.
    _snapRefreshP = null;
    const s = await refreshSnapshot();
    if (!s.ok) throw new Error(snapErrText(s.reason));
  } catch (e) {
    if (!S.snapshotError) S.snapshotError = 'manual';
    console.warn('[snapshot] manual refresh failed:', e.message);
  } finally {
    _stripBusy = false;
    renderDataAsOf();
  }
}

// ── "Data as of" strip ──────────────────────────────────────────────────────
function renderDataAsOf() {
  const el = document.getElementById('data-asof');
  if (!el) return;
  if (!SNAP_URL) { el.style.display = 'none'; return; }
  if (_stripBusy) {
    el.style.display = '';
    el.className = 'data-asof asof-busy';
    el.textContent = '⟳ Pulling the latest data. Wait for about 15 sec';
    return;
  }
  if (S.snapshotExpired || (S.snapshotError && !S.snapshotAt)) {
    el.style.display = '';
    el.className = 'data-asof asof-expired';
    el.textContent = snapErrText(S.snapshotError || 'unauthorized') + '. Tap to retry';
    return;
  }
  if (S.snapshotError && S.snapshotAt) {
    // Data is on screen but the last refresh did not land — say so without
    // pretending the session died.
    el.style.display = '';
    el.className = 'data-asof asof-stale';
    el.textContent = snapErrText(S.snapshotError) +
      ', last update ' + fmtAgo(S.snapshotAt) + '. Tap to retry';
    return;
  }
  if (!S.snapshotAt) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.className = 'data-asof ' + (ageMinutes(S.snapshotAt) > 15 ? 'asof-stale' : 'asof-ok');
  el.textContent = ageMinutes(S.snapshotAt) < 2 ? '✓ Live. Tap to re-check'
    : 'Data as of ' + fmtClock(S.snapshotAt) + ', ' + ageMinutes(S.snapshotAt) +
      ' min old. Tap to refresh';
}

function ageMinutes(ts) {
  return Math.max(0, Math.round((Date.now() - ts) / 60000));
}
function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtAgo(ts) {
  const m = ageMinutes(ts);
  return m < 1 ? 'just now' : m + ' min ago';
}

// Keep the age honest without a reload — the strip is the only place the user
// can see how stale their numbers are. The same tick re-pulls the snapshot once
// it is 5 minutes old: boot no longer reads from Google on a healthy Worker, so
// this is now the only thing that moves data forward during a long session. A
// snapshot fetch is a Worker read (free tier), not Apps Script runtime.
const SNAP_REPULL_MIN = 5;
setInterval(() => {
  renderDataAsOf();
  if (!SNAP_URL || !S.snapshotAt || S.snapshotExpired) return;
  if (ageMinutes(S.snapshotAt) >= SNAP_REPULL_MIN) refreshSnapshot();
}, 30000);
