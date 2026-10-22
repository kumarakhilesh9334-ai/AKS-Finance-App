// ── APPROVALS ─────────────────────────────────────────────────────────────
// Submissions stored in Unapproved_Loan / Unapproved_EMI sheets.
// Approved → appended to Input / logged EMI sheets, deleted from unapproved.
// Rejected → status updated in unapproved sheet, kept for reference.

// ── Fetch pending ─────────────────────────────────────────────────────────
async function fetchPendingFromSheets() {
  if (!S.sheetsUrl) return;
  const btn = $('btn-refresh-pending');
  if (btn) { btn.disabled = true; btn.textContent = '↻ Refreshing…'; }
  try {
    const data = await gasGet('readPending', {}, { priority: PRIORITY.pending });
    if (!data.ok) throw new Error(data.error);
    // Single atomic assignment — a render never sees a half-updated list.
    S.pending = data.pending;
    S._submittedEmis = {}; // server is now source of truth
    cacheState();
    refreshNav();
    // Always re-render these pages when data arrives — regardless of current page
    renderApprovals($('appr-search') ? $('appr-search').value : '');
    rerenderActiveTab();
  } catch(err) {
    console.warn('fetchPending error:', err.message);
    // Still re-render with whatever is in S.pending (may be empty)
    renderApprovals($('appr-search') ? $('appr-search').value : '');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh'; }
    // Keep partials in sync
    fetchApprovedPartials();
  }
}

// ── Apps Script transport ──────────────────────────────────────────────────
// Concurrency queue: at most GAS_MAX_CONCURRENT requests in flight, admitted in
// PRIORITY order. Overlapping heavy calls are what pushed Google into the
// 5–37 second responses that ended in a 404; the cap stops the boot burst from
// arriving as one thundering herd, and priority keeps a card click or a user
// write from queueing behind a background refresh.
const GAS_MAX_CONCURRENT = 2;
let _gasActive = 0;
const _gasQueue = [];

function gasAcquire(priority) {
  return new Promise(resolve => {
    _gasQueue.push({ priority: priority, resolve: resolve });
    gasDrain();
  });
}
function gasRelease() {
  _gasActive = Math.max(0, _gasActive - 1);
  gasDrain();
}
function gasDrain() {
  while (_gasActive < GAS_MAX_CONCURRENT && _gasQueue.length) {
    // Stable across engines for equal priorities: arrival order is preserved.
    _gasQueue.sort((a, b) => a.priority - b.priority);
    _gasActive++;
    _gasQueue.shift().resolve();
  }
}

// Classify the HTTP response BEFORE anyone tries to JSON-parse it. Google's
// content-service 302 is normal and must not be treated as an error; the real
// bug was a later hop answering 404 with an HTML error page, which used to
// surface as "Unexpected token '<'".
//
// A DEFINITE non-2xx status means the script did not run, so the write did not
// land — that is a confirmed failure, not an unknown. It is tagged with
// `httpStatus` and deliberately NOT with `transport`, so runAction records
// 'failed' (retryable, message carries the code) instead of 'unconfirmed'
// (sticky for the whole session). `transport` is reserved for the two cases
// where we genuinely cannot know: the network broke, or Google answered HTML
// instead of JSON.
async function gasReadJson(res) {
  if (!res.ok) {
    const e = new Error('HTTP ' + res.status + (res.redirected ? ' (Google redirect)' : ''));
    e.httpStatus = res.status;
    throw e;
  }
  try {
    return await res.json();
  } catch (e) {
    const e2 = new Error('HTTP ' + res.status + ' returned HTML instead of JSON');
    e2.transport = true;
    throw e2;
  }
}

// Google Apps Script POST helper — uses a form submission trick to
// bypass CORS while still sending a parseable body.
// Apps Script receives the JSON in e.parameter.payload
// Returns { ok:true, ... } | { ok:false, error, httpStatus? } | { ok:false, transport:true }.
// `transport:true` means the request itself broke: the script may well have run
// during the 302 leg, so the caller must treat the outcome as UNKNOWN, not
// failed. A definite HTTP error status is NOT transport — it carries
// `httpStatus` and is a confirmed failure the caller may retry. POSTs are
// never retried by the transport — they are not idempotent.
// login and restoreSession ride on POST but are pure reads. Treating them as
// writes had two real costs: restoreSession bumped the loan-write generation on
// every page load, which discarded the fresh readAllLoans that raced with it
// (forcing a pointless retry), and it stamped lastWriteAt, which made every
// snapshot captured before sign-in look stale. Only genuine mutations get the
// write path.
const GAS_SESSION_ACTIONS = { login: 1, restoreSession: 1, pushSnapshotNow: 1 };

async function gasPost(payload, opts) {
  const form = new FormData();
  payload._userId = S.cu ? S.cu.id : '';
  payload._token  = S._token || '';
  // TRANSITIONAL: a device that signed in before sessions replaced the PIN
  // keeps working off the PIN it still holds in memory until it has minted a
  // token (auth.js does that on the next successful boot). The moment a token
  // exists it is used and the PIN is gone — this branch never runs again.
  if (!payload._token && S.cu && S.cu.pin) payload._pin = S.cu.pin;
  form.append('payload', JSON.stringify(payload));
  // Writes must never be followed by a read. noteLoanWrite() bumps the loan-write
  // generation so any read already in flight is discarded as a stale pre-write
  // snapshot instead of being painted. lastWriteAt is what tells applySnapshot()
  // to reject a snapshot that was built before this write landed. The full-load
  // machinery is deliberately left alone here — see scheduleFullLoadsRetry.
  const isMutation = !GAS_SESSION_ACTIONS[payload.action];
  if (isMutation) {
    noteLoanWrite();
    S.lastWriteAt = Date.now();
  }
  const priority = (opts && opts.priority !== undefined) ? opts.priority : PRIORITY_WRITE;
  await gasAcquire(priority);
  try {
    const res = await fetch(S.sheetsUrl, { method:'POST', body: form });
    return await gasReadJson(res);
  } catch (err) {
    // Preserve a definite status code as a confirmed failure; only genuine
    // network/parse breaks are "unknown".
    if (err && err.httpStatus) {
      return { ok: false, error: err.message || ('HTTP ' + err.httpStatus), httpStatus: err.httpStatus };
    }
    return { ok: false, transport: true, error: err.message || 'Network error' };
  } finally {
    gasRelease();
  }
}

// Authenticated GET helper — auto-injects the session token as a query param.
// The PIN is never placed in a URL: a URL ends up in server logs, proxy logs,
// browser history and shoulder-surfed screenshots, so the only credential that
// travels here is the session token. The PIN-carrying fallback below exists
// solely for a device that has not yet exchanged its stored PIN for a token.
// Identical concurrent GETs share one in-flight request instead of doubling up.
// Pass { signal } to make the request abortable (see preemptFullLoadRetry) — an
// aborted request never consumes a retry attempt, because the abort is deliberate.
// Pass { priority } to choose its slot in the transport queue (see PRIORITY).
const _inflightGets = {};
async function gasGet(action, params = {}, opts = {}) {
  params.action = action;
  params._userId = S.cu ? S.cu.id : '';
  params._token  = S._token || '';
  if (!params._token && S.cu && S.cu.pin) params._pin = S.cu.pin;   // see note above
  const qs = Object.entries(params)
    .map(([k,v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v === undefined ? '' : v))
    .join('&');
  const signal = opts && opts.signal;
  const priority = (opts && opts.priority !== undefined) ? opts.priority : PRIORITY_DEFAULT;
  // Share an in-flight request only when it is interchangeable with this one. An
  // untargeted caller may reuse any request, but an abortable caller must never
  // inherit a foreign signal: it could not cancel it, and a preempted entry would
  // poison the next attempt by handing it the aborted result.
  const entry = _inflightGets[qs];
  if (entry && (!signal || entry.signal === signal)) return entry.promise;
  // Retry transport-level failures (network errors / HTML instead of JSON) up to
  // 2 more times with backoff — reads are idempotent, safe to retry.
  const DELAY = [0, 1000, 2000];
  const token = { signal: signal, promise: null };
  _inflightGets[qs] = token;   // register first so a synchronous return still cleans up
  token.promise = (async () => {
    try {
      for (let attempt = 0; attempt < DELAY.length; attempt++) {
        if (DELAY[attempt]) await new Promise(r => setTimeout(r, DELAY[attempt]));
        if (signal && signal.aborted) return { ok: false, error: 'aborted', aborted: true };
        // The queue slot is held only around the request itself — never during
        // the backoff sleep, or a slow retry would starve everything behind it.
        await gasAcquire(priority);
        try {
          const res = await fetch(S.sheetsUrl + '?' + qs, { cache: 'no-store', signal: signal });
          return await gasReadJson(res);
        } catch (err) {
          if (signal && signal.aborted) return { ok: false, error: 'aborted', aborted: true };
          if (attempt === DELAY.length - 1) {
            // A definite status is a confirmed miss (still worth the retries above
            // — Google answers 404 under congestion); only network/HTML breaks are
            // transport-level.
            if (err && err.httpStatus) return { ok: false, error: err.message, httpStatus: err.httpStatus };
            return { ok: false, transport: true, error: err.message || 'Network error' };
          }
        } finally {
          gasRelease();
        }
      }
    } finally {
      // Identity-checked: a newer attempt may already own this key.
      if (_inflightGets[qs] === token) delete _inflightGets[qs];
    }
  })();
  return token.promise;
}

// ── Session action registry ────────────────────────────────────────────────
// In-memory only (never written to localStorage), so a page refresh falls back
// to the server as the source of truth. Blocks a repeat of an action this
// session already believes landed — the cause of duplicate rows from
// double-submits — and remembers writes we could not confirm so they are not
// blindly retried into duplicates.
function actionKey(kind, ...parts) { return kind + '|' + parts.join('|'); }

// 'unconfirmed' always blocks: we don't know whether it landed, so a blind
// retry risks a duplicate row. 'done' blocks only when the caller says repeats
// are not legitimate — resubmitting an EMI is a duplicate, but re-revising a
// date is a normal correction and must stay possible.
function actionBlocked(key, opts) {
  const st = (S._actionLog || {})[key];
  if (st === 'unconfirmed') return 'The previous attempt could not be confirmed. Refresh the page before trying again.';
  if (st === 'done' && (!opts || opts.blockRepeat !== false))
    return 'This was already submitted in this session. Refresh the page to see the latest status.';
  return '';
}

function recordAction(key, state) {
  if (!S._actionLog) S._actionLog = {};
  S._actionLog[key] = state;
}

// One POST, one explicit outcome:
//   'done'         confirmed by the server
//   'failed'       server said no — safe to retry
//   'unconfirmed'  transport broke after the write may have landed — do NOT retry
//   'blocked'      this session already recorded an attempt under this key
async function runAction(key, payload, opts) {
  const block = actionBlocked(key, opts);
  if (block) return { outcome: 'blocked', message: block };
  const res = await gasPost(payload, opts);
  if (res.ok)        { recordAction(key, 'done');        return { outcome: 'done', res: res }; }
  if (res.transport) { recordAction(key, 'unconfirmed'); return { outcome: 'unconfirmed', res: res }; }
  recordAction(key, 'failed');
  return { outcome: 'failed', res: res };
}

// Shared message for write failures at sites that do not use runAction.
// Routes transport failures to a yellow warning rather than the red error
// dialog — "we don't know" is not the same as "it failed".
function showWriteFailure(res, label) {
  if (res && res.transport) {
    showAlert("Couldn't confirm " + label + ' — it may still have saved. Refresh the page to check.', 'w');
    return;
  }
  showAlert(label + ' failed: ' + ((res && res.error) || 'Unknown error'), 'e');
}

// ── Approvals: two-column layout ──────────────────────────────────────────
function renderApprovals(q) {
  const query = (q === undefined ? ($('appr-search') ? $('appr-search').value : '') : String(q)).toLowerCase();
  const el1 = $('approvals-loans-list'), el2 = $('approvals-emis-list');
  if (!el1 || !el2) return;
  const match = p => !query || p.data.loanId.toLowerCase().includes(query) || (p.data.customerName||'').toLowerCase().includes(query);
  const loans = S.pending.filter(p => p.status === 'pending' && p.type === 'loan' && match(p)).reverse();
  const emis  = S.pending.filter(p => p.status === 'pending' && p.type === 'emi' && match(p)).reverse();
  el1.innerHTML = loans.length
    ? loans.map(p => subCard(p, true)).join('')
    : '<div class="empty">No pending loans 🎉</div>';
  el2.innerHTML  = emis.length
    ? emis.map(p  => subCard(p, true)).join('')
    : '<div class="empty">No pending EMIs 🎉</div>';
  const c1 = $('appr-loan-count'), c2 = $('appr-emi-count');
  if (c1) c1.textContent = loans.length;
  if (c2) c2.textContent = emis.length;
}

// ── Approve ───────────────────────────────────────────────────────────────
async function approve(id, type) {
  const item = S.pending.find(p => p.id === id && (!type || p.type === type));
  if (!item) return;

  const d = item.data;
  if (item.type === 'loan') {
    const bd = parseDDMonYY(d.billDate);
    const es = parseDDMonYY(d.emiStart);
    if (bd && es) {
      const diff = Math.round((es - bd) / (1000*60*60*24));
      if (diff < 20) {
        if (!confirm('EMI starting in just ' + diff + ' day' + (diff===1?'':'s') + ' from bill date.\nPlease verify bill date and EMI start date are correct.\n\nApprove anyway?')) return;
      } else if (diff > 40) {
        if (!confirm('EMI starting in ' + diff + ' days from bill date (>40 days gap).\nPlease verify bill date and EMI start date are correct.\n\nApprove anyway?')) return;
      }
    }
  } else {
    if (d.scheduledDate) {
      const sd = parseDDMonYY(d.scheduledDate);
      if (sd) {
        const today = new Date(); today.setHours(0,0,0,0);
        const diff = Math.round((sd - today) / (1000*60*60*24));
        if (diff > 10) {
          if (!confirm('Scheduled date for EMI ' + d.emiNum + ' is ' + diff + ' days from now. Approve anyway?')) return;
        }
      }
    }
  }

  showAlert('Approving…', 'w');
  showLoader();
  try {
    const r = await runAction(actionKey('approve', id), {action:'approvePending', id, type:item.type, data:item.data});
    if (r.outcome === 'blocked') {
      showAlert(r.message, 'e');
    } else if (r.outcome === 'unconfirmed') {
      showAlert("Couldn't confirm the approval — it may still have gone through. Refresh the page to check.", 'w');
    } else if (r.outcome === 'done') {
      // Server confirmed — update the local list directly, no extra round-trips.
      const isPartial = item.type === 'emi'
        && String(item.data.miscType || item.data.reason || '').toLowerCase() === 'partial payment';
      if (isPartial) item.status = 'approved';   // stays in sheet as approved partial
      else S.pending = S.pending.filter(p => p.id !== id);
      cacheState();
      refreshNav();
      renderApprovals($('appr-search') ? $('appr-search').value : '');
      rerenderActiveTab();
      showAlert('Approved ✓');
    } else {
      const err = r.res && r.res.error;
      if (err === 'duplicate_emi') {
        showAlert('This EMI already exists in the logged EMI sheet!', 'e');
      } else {
        showAlert('Approval failed: ' + (err || 'Unknown error'), 'e');
      }
    }
  } catch(err) {
    showAlert('Sync failed: ' + err.message, 'w');
  } finally { hideLoader(); }
}

// ── Reject ────────────────────────────────────────────────────────────────
async function reject(id, type) {
  const note = prompt('Reason for rejection (optional):') || '';
  const item = S.pending.find(p => p.id === id && (!type || p.type === type));
  if (!item) return;
  showAlert('Rejecting…', 'w');
  showLoader();
  try {
    const r = await runAction(actionKey('reject', id), {action:'rejectPending', id, type:item.type, note});
    if (r.outcome === 'blocked') {
      showAlert(r.message, 'e');
    } else if (r.outcome === 'unconfirmed') {
      showAlert("Couldn't confirm the rejection — it may still have gone through. Refresh the page to check.", 'w');
    } else if (r.outcome === 'done') {
      // Server confirmed — mark rejected locally, no extra round-trips.
      item.status = 'rejected';
      item.note   = note;
      // The submission is no longer pending, so the local "already submitted"
      // marker must go too — otherwise the Submit for approval button stays
      // greyed until a full page reload.
      if (item.type === 'emi' && S._submittedEmis && item.data) {
        delete S._submittedEmis[item.data.loanId + '_' + item.data.emiNum];
      }
      cacheState();
      refreshNav();
      renderApprovals($('appr-search') ? $('appr-search').value : '');
      rerenderActiveTab();
      showAlert('Entry rejected.', 'w');
    } else {
      showAlert('Rejection failed: ' + ((r.res && r.res.error) || 'Unknown error'), 'e');
    }
  } catch(err) {
    showAlert('Sync failed: ' + err.message, 'w');
  } finally { hideLoader(); }
}

// ── Edit ──────────────────────────────────────────────────────────────────
function editSubmission(id, type) {
  const item = S.pending.find(p => p.id === id && (!type || p.type === type));
  if (!item) return;
  S.editingId = id;
  S.editingType = type || item.type;
  populateEditModal(item);
  $('edit-modal').style.display = 'flex';
}

const DEVICE_TYPES = ['Mobile','TV','Sound Box','Fridge','AC','Washing Machine','Air Cooler',
  'Induction','Mixer','Gas Stove','Inverter Battery','Inverter','Inverter & Battery','Loan','Fan','Other'];
const LOCKER_OPTIONS = ['101 Locker','YOGIC Locker','ZTE Locker','Other','None'];
const AK_SHARE_OPTIONS = [['0','0% (AKS only)'],['50','50%'],['100','100% (AK only)'],['custom','Custom']];

// Mirror the EMI recording form (ov-emi-* in index.html).
const EMI_RECEIVED_OPTIONS = ['TRUE','FALSE'];
const EMI_MODE_OPTIONS     = ['Cash','UPI','Bank transfer','Other'];
const EMI_REASON_MULTI     = 'Multiple EMI Payment';
const EMI_REASON_OPTIONS   = [['','- Select reason -'],
  'Late payment fine included','Extra EMI received','Early loan closing settlement',
  'Partial payment','Default Adjustment', EMI_REASON_MULTI];
// Shared look for inputs the user must not type into (derived from the loan).
const EDIT_RO_STYLE = 'background:#f5f5f3;color:#999;cursor:not-allowed';

function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function populateEditModal(item) {
  const d = item.data;
  $('edit-modal-title').textContent = item.type === 'loan'
    ? 'Edit loan: ' + d.loanId
    : 'Edit EMI: ' + d.loanId + ' · EMI ' + d.emiNum;

  let html = '';
  if (item.type === 'loan') {
    const isMobile   = String(d.deviceType||'').trim() === 'Mobile';
    const akShare    = parseFloat(d.akShare)||0;
    const akShareSel = (akShare===0 || akShare===50 || akShare===100) ? String(akShare) : 'custom';
    const lockApp    = String(d.lockingApp||'').trim();
    const lockAppSel = LOCKER_OPTIONS.includes(lockApp) ? lockApp : (lockApp ? 'Other' : LOCKER_OPTIONS[0]);

    html = editField('Customer name',    'ed-cname',    d.customerName)
         + editField('Phone',            'ed-phone',    d.phone)
         + editField('Aadhaar/PAN',      'ed-idnum',    d.idNum)
         + editField('Bill date',        'ed-billdate', ymdFromDD(d.billDate), 'date')
         + editField('Model',            'ed-model',    d.model)
         + editSelect('Device type',     'ed-dtype',    DEVICE_TYPES, d.deviceType, 'onEditDeviceTypeChange()')
         + editField('Device amount ₹',  'ed-price',    d.price,    'number', 'onEditEmiCalc()')
         + editField('Down payment ₹',   'ed-down',     d.downPayment, 'number', 'onEditEmiCalc()')
         + editField('Processing fee ₹', 'ed-pfee',     d.processingFee, 'number', 'onEditEmiCalc()')
         + `<div id="ed-applock-wrap" style="margin-bottom:0.6rem;${isMobile?'':'display:none'}">
              <label style="font-size:12px;color:#666;display:block;margin-bottom:3px">App lock ₹</label>
              <input type="number" id="ed-applock" value="${escAttr(d.appLockCharge)}" oninput="onEditEmiCalc()" style="width:100%;padding:8px 10px;border:0.5px solid #ccc;border-radius:8px;font-size:13px">
            </div>`
         + `<div id="ed-lockapp-wrap" style="margin-bottom:0.6rem;${isMobile?'':'display:none'}">
              <label style="font-size:12px;color:#666;display:block;margin-bottom:3px">Locking App</label>
              <select id="ed-lockapp" onchange="onEditLockAppChange()" style="width:100%;padding:8px 10px;border:0.5px solid #ccc;border-radius:8px;font-size:13px;background:#fff">${
                LOCKER_OPTIONS.map(o => `<option${o===lockAppSel?' selected':''}>${o}</option>`).join('')
              }</select>
            </div>`
         + `<div id="ed-lockapp-other-wrap" style="margin-bottom:0.6rem;${(isMobile && lockAppSel==='Other')?'':'display:none'}">
              <label style="font-size:12px;color:#666;display:block;margin-bottom:3px">Other Locker name <span style="color:#A32D2D">*</span></label>
              <input type="text" id="ed-lockapp-other" value="${escAttr(lockAppSel==='Other'?d.lockingApp:'')}" placeholder="Enter locker name" style="width:100%;padding:8px 10px;border:0.5px solid #ccc;border-radius:8px;font-size:13px">
            </div>`
         + `<div id="ed-lockappcode-wrap" style="margin-bottom:0.6rem;${isMobile?'':'display:none'}">
              <label style="font-size:12px;color:#666;display:block;margin-bottom:3px">Lock App Code</label>
              <input type="text" id="ed-lockappcode" value="${escAttr(d.lockAppCode||'')}" placeholder="e.g. ABC1234" style="width:100%;padding:8px 10px;border:0.5px solid #ccc;border-radius:8px;font-size:13px">
            </div>`
         + editField('EMI duration',     'ed-tenure',   d.tenure,   'number', 'onEditEmiCalc()')
         + editField('Monthly EMI ₹',    'ed-emi',      d.monthlyEmi, 'number', 'onEditEmiCalc()')
         + editField('Interest ₹',       'ed-int',      d.interest, 'number', '', '', EDIT_RO_STYLE, 'readonly')
         + editField('EMI start date',   'ed-emistart', ymdFromDD(d.emiStart), 'date', '', 'onEditEmiStartChange()')
         + editSelect('AK share (%)',    'ed-akshare',  AK_SHARE_OPTIONS, akShareSel, 'onEditAkShareChange()')
         + `<div id="ed-akcustom-wrap" style="margin-bottom:0.6rem;${akShareSel==='custom'?'':'display:none'}">
              <label style="font-size:12px;color:#666;display:block;margin-bottom:3px">AK custom share (%)</label>
              <input type="number" id="ed-akcustom" value="${akShareSel==='custom'?escAttr(akShare):''}" min="0" max="100" placeholder="0-100" style="width:100%;padding:8px 10px;border:0.5px solid #ccc;border-radius:8px;font-size:13px">
            </div>`
         + editField('Guarantor',        'ed-guar',     d.guarantor);
  } else {
    // Reason may be stored as "Multiple EMI Payment (3)" -- approve() parses
    // the count back out of it, so split it apart and rebuild it on save.
    const miscType   = String(d.miscType || d.reason || '');
    const isMulti    = miscType.indexOf(EMI_REASON_MULTI) === 0;
    const multiCount = (miscType.match(/\((\d+)\)/) || [])[1] || '';
    const reasonBase = isMulti ? EMI_REASON_MULTI : miscType;
    const reasonSel  = EMI_REASON_OPTIONS.some(o => (Array.isArray(o)?o[0]:String(o)) === reasonBase) ? reasonBase : '';
    const rcvd       = String(d.received).toLowerCase() !== 'false' ? 'TRUE' : 'FALSE';
    const modeRaw    = String(d.mode||'').trim();

    // Loan ID, EMI number and Expected are derived from the loan in the
    // recording form; editing them here would corrupt EMI_ID / MISC.
    html = editField('Loan ID',        'ed-loanid',   d.loanId,         'text', '', '', EDIT_RO_STYLE, 'readonly')
         + editField('Customer name',  'ed-cname',    d.customerName)
         + editField('Mobile model',   'ed-model',    d.model)
         + editField('EMI number',     'ed-eminum',   d.emiNum,         'number', '', '', EDIT_RO_STYLE, 'readonly')
         + editField('EMI start date', 'ed-emistart', ymdFromDD(d.emiStartDate), 'date', '', '', EDIT_RO_STYLE, 'readonly')
         + editField('Expected ₹',     'ed-expamt',   d.expectedAmount, 'number', '', '', EDIT_RO_STYLE, 'readonly')
         + editField('Received ₹',     'ed-amount',   d.amount,         'number', 'onEditEmiDiffChange()')
         + editField('Payment date',   'ed-date',     ymdFromDD(d.date), 'date')
         + editSelect('Received',      'ed-rcvd',     EMI_RECEIVED_OPTIONS, rcvd)
         + editSelect('Payment mode',  'ed-mode',     EMI_MODE_OPTIONS, EMI_MODE_OPTIONS.includes(modeRaw) ? modeRaw : EMI_MODE_OPTIONS[0])
         + editField('Notes',          'ed-notes',    d.notes)
         + `<div id="ed-reason-wrap" style="margin-bottom:0.6rem;display:none">
               <label style="font-size:12px;color:#666;display:block;margin-bottom:3px">Reason for difference <span style="color:#A32D2D">*</span></label>
               <select id="ed-reason" onchange="onEditEmiReasonChange()" style="width:100%;padding:8px 10px;border:0.5px solid #ccc;border-radius:8px;font-size:13px;background:#fff">${
                 EMI_REASON_OPTIONS.map(o => {
                   const val  = Array.isArray(o) ? o[0] : String(o);
                   const text = Array.isArray(o) ? o[1] : String(o);
                   return `<option value="${escAttr(val)}"${val===reasonSel?' selected':''}>${escAttr(text)}</option>`;
                 }).join('')
               }</select>
             </div>`
         + `<div id="ed-multi-wrap" style="margin-bottom:0.6rem;display:none">
               <label style="font-size:12px;color:#666;display:block;margin-bottom:3px">How many EMIs does this amount cover? <span style="color:#A32D2D">*</span></label>
               <input type="number" id="ed-multicount" min="2" value="${escAttr(multiCount)}" placeholder="e.g. 3" style="width:100%;padding:8px 10px;border:0.5px solid #ccc;border-radius:8px;font-size:13px">
               <div id="ed-multi-hint" style="font-size:11px;color:#888;margin-top:4px"></div>
             </div>`
         + `<div id="ed-diff-wrap" style="margin-bottom:0.6rem;display:none"><div class="diff-warn" id="ed-diff-text"></div></div>`;
  }
  $('edit-modal-body').innerHTML = html;
  if (item.type === 'loan') { onEditLockAppChange(); onEditAkShareChange(); }
  else { onEditEmiDiffChange(); }
}

function editField(label, id, value, type='text', oninput='', onchange='', inputStyle='', extra='') {
  const val = value != null ? value : '';
  return `<div style="margin-bottom:0.6rem">
    <label style="font-size:12px;color:#666;display:block;margin-bottom:3px">${label}</label>
    <input type="${type}" id="${id}" value="${escAttr(val)}"${oninput?` oninput="${oninput}"`:''}${onchange?` onchange="${onchange}"`:''} style="width:100%;padding:8px 10px;border:0.5px solid #ccc;border-radius:8px;font-size:13px${inputStyle?`;${inputStyle}`:''}"${extra?' '+extra:''}>
  </div>`;
}

function editSelect(label, id, options, sel, onchange='') {
  const opts = options.map(opt => {
    const val  = Array.isArray(opt) ? opt[0] : String(opt);
    const text = Array.isArray(opt) ? opt[1] : String(opt);
    return `<option value="${escAttr(val)}"${val===String(sel)?' selected':''}>${escAttr(text)}</option>`;
  }).join('');
  return `<div style="margin-bottom:0.6rem">
    <label style="font-size:12px;color:#666;display:block;margin-bottom:3px">${label}</label>
    <select id="${id}"${onchange?` onchange="${onchange}"`:''} style="width:100%;padding:8px 10px;border:0.5px solid #ccc;border-radius:8px;font-size:13px;background:#fff">${opts}</select>
  </div>`;
}

// ── Edit-modal field rules (mirror the New Loan form) ─────────────────────
function onEditDeviceTypeChange() {
  const isMobile = $('ed-dtype').value === 'Mobile';
  $('ed-applock').value = isMobile ? 299 : 0;
  // Same Mobile-only rule as the New Loan form: app lock charge, the locker
  // select and the Lock App Code only make sense on a locked phone.
  const appWrap = $('ed-applock-wrap');
  if (appWrap) appWrap.style.display = isMobile ? '' : 'none';
  const wrap = $('ed-lockapp-wrap');
  if (wrap) wrap.style.display = isMobile ? '' : 'none';
  const codeWrap = $('ed-lockappcode-wrap');
  if (codeWrap) codeWrap.style.display = isMobile ? '' : 'none';
  onEditLockAppChange();
  onEditEmiCalc();
}

function onEditLockAppChange() {
  const wrap = $('ed-lockapp-other-wrap');
  if (wrap) wrap.style.display = ($('ed-lockapp').value === 'Other') ? '' : 'none';
}

function onEditAkShareChange() {
  const wrap = $('ed-akcustom-wrap');
  if (wrap) wrap.style.display = ($('ed-akshare').value === 'custom') ? '' : 'none';
}

function onEditEmiCalc() {
  const emi     = parseFloat($('ed-emi').value)||0;
  const tenure  = parseFloat($('ed-tenure').value)||0;
  const price   = parseFloat($('ed-price').value)||0;
  const down    = parseFloat($('ed-down').value)||0;
  const pfee    = parseFloat($('ed-pfee').value)||0;
  $('ed-int').value = Math.max(0, Math.round(emi*tenure - (price-down) - pfee));
}

function onEditEmiStartChange() {
  const val = $('ed-emistart').value; if (!val) return;
  if (![5,10,15,20,25].includes(parseInt(val.split('-')[2]))) {
    $('ed-emistart').value = '';
    showAlert('EMI start date must be on 5, 10, 15, 20 or 25.','e');
  }
}

function editEmiItem_() {
  return S.pending.find(p => p.id === S.editingId && (!S.editingType || p.type === S.editingType));
}

function editEmiLoan_() {
  const item = editEmiItem_();
  if (!item || item.type !== 'emi') return null;
  const loanId = item.data.loanId;
  return (S.sheetLoans && S.sheetLoans.find(l => l.loanId === loanId)) || null;
}

// Mirror checkOverviewEmiDiff(): the reason dropdown only matters when the
// amount differs from the standard EMI.
function onEditEmiDiffChange() {
  const wrap = $('ed-reason-wrap');
  const dw   = $('ed-diff-wrap');
  if (!wrap) return;
  const raw = $('ed-amount') ? $('ed-amount').value : '';
  const expected = parseFloat(($('ed-expamt') || {}).value) || 0;
  if (raw === '') {
    wrap.style.display = 'none';
    dw.style.display   = 'none';
    onEditEmiReasonChange();
    return;
  }
  const diff = (parseFloat(raw) || 0) - expected;
  if (Math.abs(diff) > 1) {
    wrap.style.display = '';
    dw.style.display   = '';
    if ($('ed-diff-text'))
      $('ed-diff-text').textContent = 'Differs from standard EMI ' + fmt(expected) + ' by ' + (diff>0?'+':'-') + fmt(Math.abs(diff)) + '. Please select a reason.';
  } else {
    wrap.style.display = 'none';
    dw.style.display   = 'none';
  }
  onEditEmiReasonChange();
}

// Mirror checkOverviewEmiReason(): the "how many EMIs" box only appears for
// Multiple EMI Payment, and only while the reason dropdown is itself visible.
function onEditEmiReasonChange() {
  const wrap = $('ed-multi-wrap');
  if (!wrap) return;
  const rwrap = $('ed-reason-wrap');
  const isMulti = !!($('ed-reason') && $('ed-reason').value === EMI_REASON_MULTI)
               && !!rwrap && rwrap.style.display !== 'none';
  wrap.style.display = isMulti ? '' : 'none';
  if (isMulti) {
    const loan = editEmiLoan_();
    const remaining = loan ? Math.max(0, (loan.emiDuration||0) - (loan.numReceivedEmi||0)) : 0;
    const hint = $('ed-multi-hint');
    if (hint) hint.textContent = 'EMIs remaining for this loan: ' + remaining + '. Minimum 2.';
  }
}

async function saveEdit() {
  const id   = S.editingId;
  const type = S.editingType;
  const item = S.pending.find(p => p.id === id && (!type || p.type === type));
  if (!item) return;
  const d = item.data;

  if (item.type === 'loan') {
    const cname      = $('ed-cname').value.trim();
    const phone      = $('ed-phone').value.trim();
    const idNum      = $('ed-idnum').value.trim();
    const billDate   = $('ed-billdate').value;
    const model      = $('ed-model').value.trim();
    const dtype      = $('ed-dtype').value;
    const price      = parseFloat($('ed-price').value);
    const down       = parseFloat($('ed-down').value);
    const pfee       = parseFloat($('ed-pfee').value);
    const applock    = parseFloat($('ed-applock').value);
    const tenure     = parseFloat($('ed-tenure').value);
    const monthlyEmi = parseFloat($('ed-emi').value);
    const emiStart   = $('ed-emistart').value;
    const akSel      = $('ed-akshare').value;
    const guar       = $('ed-guar').value.trim();
    const lockApp    = $('ed-lockapp') ? $('ed-lockapp').value : '';
    const lockOther  = $('ed-lockapp-other') ? $('ed-lockapp-other').value.trim() : '';

    // Same gates as the New Loan form
    if (!cname||!phone||!idNum||!billDate||!model||!dtype||!price||!tenure||!monthlyEmi) {
      showAlert('Please fill in all required fields.','e'); return;
    }
    if (isNaN(down))    { showAlert('Please fill in Down payment.','e'); return; }
    if (isNaN(pfee))    { showAlert('Please fill in Processing fee.','e'); return; }
    if (isNaN(applock)) { showAlert('Please fill in App lock charge.','e'); return; }
    const akPct = akSel === 'custom' ? parseFloat($('ed-akcustom').value) : parseFloat(akSel);
    if (isNaN(akPct) || akPct < 0 || akPct > 100) {
      showAlert('Please enter the custom AK share percentage (0-100).','e'); return;
    }
    if (!emiStart) {
      showAlert('Please select an EMI start date.','e'); return;
    }
    if (![5,10,15,20,25].includes(parseInt(emiStart.split('-')[2]))) {
      showAlert('EMI start date must be on 5, 10, 15, 20 or 25.','e'); return;
    }
    if (dtype === 'Mobile') {
    if (dtype === 'Mobile' && lockApp === 'Other' && !lockOther) {
      showAlert('Please enter the Other Locker name.','e'); return;
    }
    }
    const bd = new Date(billDate + 'T00:00:00');
    const es = new Date(emiStart + 'T00:00:00');
    const diffDays = Math.round((es - bd) / (1000*60*60*24));
    if (diffDays < 20) {
      if (!confirm('EMI starting in just ' + diffDays + ' day' + (diffDays===1?'':'s') + ' from bill date.\nPlease verify bill date and EMI start date are correct.\n\nSave anyway?')) return;
    } else if (diffDays > 40) {
      if (!confirm('EMI starting in ' + diffDays + ' days from bill date (>40 days gap).\nPlease verify bill date and EMI start date are correct.\n\nSave anyway?')) return;
    }

    const interest = Math.max(0, Math.round(monthlyEmi*tenure - (price-down) - pfee));
    d.customerName  = cname;
    d.phone         = phone;
    d.idNum         = idNum;
    d.billDate      = billDate;
    d.model         = model;
    d.deviceType    = dtype;
    d.price         = price||0;
    d.downPayment   = down||0;
    d.processingFee = pfee||0;
    d.appLockCharge = applock||0;
    d.tenure        = tenure||0;
    d.monthlyEmi    = monthlyEmi||0;
    d.interest      = interest;
    d.emiStart      = emiStart;
    d.akShare       = akPct;
    d.aksShare      = 100 - akPct;
    d.guarantor     = guar;
    d.lockingApp    = dtype === 'Mobile' ? (lockApp === 'Other' ? lockOther : lockApp) : '';
    d.lockAppCode   = dtype === 'Mobile' ? ($('ed-lockappcode') ? $('ed-lockappcode').value.trim() : '') : '';
    d.financeAmount = d.price - d.downPayment + d.appLockCharge;
    d.totalAmount   = d.financeAmount + d.processingFee + d.interest;
    d.akAmount      = Math.round(d.financeAmount * d.akShare  / 100);
    d.aksAmount     = Math.round(d.financeAmount * d.aksShare / 100);
  } else {
    const loanId    = $('ed-loanid').value.trim();
    const cname     = $('ed-cname').value.trim();
    const model     = $('ed-model').value.trim();
    const emiNum    = parseInt($('ed-eminum').value) || d.emiNum;
    const emiStart  = $('ed-emistart').value;
    const expected  = parseFloat($('ed-expamt').value);
    const amtRaw    = $('ed-amount').value;
    const amount    = parseFloat(amtRaw);
    const payDate   = $('ed-date').value;
    const reasonSel = $('ed-reason') ? $('ed-reason').value : '';

    // Same gates as the EMI recording form (submitOverviewEmi).
    if (!loanId || !cname || !model || !emiNum || !emiStart) {
      showAlert('Please fill in all required fields.','e'); return;
    }
    if (isNaN(expected)) { showAlert('Please fill in Expected.','e'); return; }
    if (amtRaw === '' || isNaN(amount)) { showAlert('Please enter the amount received.','e'); return; }
    if (!payDate) { showAlert('Please enter the payment date.','e'); return; }

    const diff = amount - expected;
    let miscType = '';
    if (Math.abs(diff) > 1) {
      if (!reasonSel) { showAlert('Please select a reason for the amount difference.','e'); return; }
      if (reasonSel === EMI_REASON_MULTI) {
        const multiCount = parseInt(($('ed-multicount')||{}).value) || 0;
        const loan = editEmiLoan_();
        const remaining = loan ? Math.max(0, (loan.emiDuration||0) - (loan.numReceivedEmi||0)) : 0;
        if (multiCount < 2) { showAlert('Please enter how many EMIs this amount covers (minimum 2).','e'); return; }
        if (multiCount > remaining) { showAlert('This loan has only ' + remaining + ' EMI(s) remaining.','e'); return; }
        if (Math.abs(amount - expected * multiCount) > 1) {
          if (!confirm(fmt(amount) + ' will be split as ' + fmt(expected) + ' per EMI across ' + multiCount + ' EMIs. Continue?')) return;
        }
        miscType = EMI_REASON_MULTI + ' (' + multiCount + ')';
      } else {
        miscType = reasonSel;
      }
    }
    // No difference -> no reason. Clears any stale one left on an earlier edit.

    d.loanId         = loanId;
    d.customerName   = cname;
    d.model          = model;
    d.emiNum         = emiNum;
    d.emiStartDate   = emiStart;
    d.expectedAmount = expected;
    d.amount         = amount;
    d.misc           = amount - expected;
    d.date           = payDate;
    d.received       = $('ed-rcvd').value !== 'FALSE';
    d.mode           = $('ed-mode').value;
    d.notes          = $('ed-notes').value;
    d.miscType       = miscType;
    d.reason         = miscType;
  }

  closeEditModal();
  showAlert('Saving…', 'w');
  showLoader();
  try {
    if (S.sheetsUrl) {
      const res = await gasPost({action:'updatePending', id, type:item.type, data:d});
      if (res.ok) {
        // `d` references item.data — the local list already holds the edits.
        cacheState();
        refreshNav();
        renderApprovals($('appr-search') ? $('appr-search').value : '');
        rerenderActiveTab();
        showAlert('Entry updated.');
      } else {
        showWriteFailure(res, 'Edit');
      }
    }
  } finally { hideLoader(); }
}

function closeEditModal() {
  $('edit-modal').style.display = 'none';
  S.editingId = null;
  S.editingType = null;
}

// ── Submission card ───────────────────────────────────────────────────────
function subCard(p, showActions, hideRoi) {
  const user = S.users.find(u => u.id === p.submittedBy);
  const date = new Date(p.submittedAt).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'});
  const bc   = p.status==='pending'?'b-pending':p.status==='approved'?'b-approved':'b-rejected';

  let detail = '';
  if (p.type === 'loan') {
    const d = p.data;
    detail = `<div style="display:flex;flex-wrap:wrap;gap:16px">
      <div class="kv kv-big">
        <span class="kv-l">Name</span>     <span class="kv-v">${d.customerName}</span>
        <span class="kv-l">Loan ID</span>  <span class="kv-v">${d.loanId}</span>
        <span class="kv-l">Interest</span> <span class="kv-v">${fmt(d.interest)}</span>
        ${!hideRoi ? `<span class="kv-l">ROI</span><span class="kv-v" style="color:#BA7517">${d.rateOfInterest}%</span>` : ''}
      </div>
      <div class="kv">
        <span class="kv-l">Bill Date</span>     <span class="kv-v">${fmtDateDD(d.billDate)}</span>
        <span class="kv-l">Phone</span>         <span class="kv-v">${d.phone}</span>
        <span class="kv-l">Aadhaar/PAN</span>   <span class="kv-v">${d.idNum}</span>
        <span class="kv-l">Model</span>         <span class="kv-v">${d.model}</span>
        <span class="kv-l">Device Type</span>   <span class="kv-v">${d.deviceType}</span>
        <span class="kv-l">Device amount</span> <span class="kv-v">${fmt(d.price)}</span>
        <span class="kv-l">Down payment</span>  <span class="kv-v">${fmt(d.downPayment)}</span>
        <span class="kv-l">Processing fee</span><span class="kv-v">${fmt(d.processingFee)}</span>
        <span class="kv-l">EMI duration</span>  <span class="kv-v">${d.tenure} months</span>
        <span class="kv-l">Monthly EMI</span>   <span class="kv-v">${fmt((d.price - d.downPayment + d.processingFee + d.interest) / (d.tenure||1))}</span>
        <span class="kv-l">EMI start</span>     <span class="kv-v">${fmtDateDD(d.emiStart)}</span>
        <span class="kv-l">App lock</span>      <span class="kv-v">${fmt(d.appLockCharge)}</span>
        ${d.lockingApp?`<span class="kv-l">Locking App</span><span class="kv-v">${d.lockingApp}</span>`:''}
        ${d.lockAppCode?`<span class="kv-l">Lock App Code</span><span class="kv-v">${d.lockAppCode}</span>`:''}
        <span class="kv-l">AK share</span>      <span class="kv-v">${d.akShare}%</span>
        ${d.guarantor?`<span class="kv-l">Guarantor</span><span class="kv-v">${d.guarantor}</span>`:''}
      </div>
    </div>`;
  } else {
    const d = p.data, diff = d.amount - d.expectedAmount;
    const loan = S.sheetLoans?.find(l => l.loanId === d.loanId);
    const extraRcv = loan ? (loan.extraEmiReceived||0) : 0;
    const adjExpected = Math.max(0, d.expectedAmount - extraRcv);
    detail = `<div style="display:flex;flex-wrap:wrap;gap:16px">
      <div class="kv kv-big">
        <span class="kv-l">Name</span>   <span class="kv-v">${d.customerName}</span>
        <span class="kv-l">Amount</span> <span class="kv-v">${fmt(d.amount)}${Math.abs(diff)>1?` (${diff>0?'+':'–'}${fmt(Math.abs(diff))})`:''}</span>
        <span class="kv-l">Date</span>   <span class="kv-v">${fmtDateDD(d.date)}</span>
      </div>
      <div class="kv">
        <span class="kv-l">Loan ID</span>     <span class="kv-v" style="color:#534AB7">${d.loanId}</span>
        <span class="kv-l">Model</span>       <span class="kv-v">${d.model}</span>
        <span class="kv-l">EMI number</span>  <span class="kv-v">EMI ${d.emiNum}</span>
        <span class="kv-l">EMI start</span>   <span class="kv-v">${fmtDateDD(d.emiStartDate)}</span>
        <span class="kv-l">Std EMI</span>    <span class="kv-v">${fmt(d.expectedAmount)}</span>
        ${adjExpected!==d.expectedAmount?`<span class="kv-l">Expected</span><span class="kv-v">${fmt(adjExpected)}</span>`:''}
        <span class="kv-l">Reason for difference</span><span class="kv-v">${d.miscType||d.reason||'—'}</span>
        <span class="kv-l">Received</span><span class="kv-v">${String(d.received).toLowerCase()!=='false'?'TRUE':'FALSE'}</span>
        ${d.mode?`<span class="kv-l">Payment mode</span><span class="kv-v">${d.mode}</span>`:''}
        ${d.notes?`<span class="kv-l">Notes</span><span class="kv-v">${d.notes}</span>`:''}
      </div>
    </div>`;
  }

  const btns = {
    approve: '<button class="btn btn-success btn-action" onclick="approve(\''+p.id+'\',\''+p.type+'\')">✓ Approve</button>',
    edit: '<button class="btn btn-action btn-action-edit" onclick="editSubmission(\''+p.id+'\',\''+p.type+'\')">✎ Edit</button>',
    reject: '<button class="btn btn-danger btn-action" onclick="reject(\''+p.id+'\',\''+p.type+'\')">✗ Reject</button>',
  };
  const actionList = showActions === true ? ['reject','edit','approve'] : (Array.isArray(showActions) ? showActions : []);
  const actionsHtml = actionList.length && p.status === 'pending'
    ? `<div class="appr-actions">${actionList.map(a => btns[a]||'').join('')}</div>`
    : p.note ? `<div style="font-size:12px;color:#A32D2D;margin-top:0.5rem">Rejection note: ${p.note}</div>` : '';

  return `<div class="card">
    <div class="card-hd">
      <div>
        <span class="tag ${p.type==='loan'?'t-loan':'t-emi'}">${p.type==='loan'?'New loan':'EMI payment'}</span>
        <div class="card-title" style="margin-top:4px">${p.type==='loan'?p.data.loanId:`${p.data.loanId} · EMI ${p.data.emiNum}`}</div>
        <div class="card-sub">By ${user?.name||p.submittedBy} · ${date}</div>
      </div>
      <span class="badge ${bc}">${p.status}</span>
    </div>
    ${detail}${actionsHtml}
  </div>`;
}

// ── Date helpers ────────────────────────────────────────────────────────────
function fmtDateDD(val) {
  if (!val) return '—';
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (val instanceof Date && !isNaN(val))
    return val.getDate() + '-' + M[val.getMonth()] + '-' + String(val.getFullYear()).slice(-2);
  if (/^\d{1,2}-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2}$/i.test(val)) return val;
  const m = String(val).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return parseInt(m[3]) + '-' + M[parseInt(m[2])-1] + '-' + m[1].slice(-2);
  return val;
}
function ymdFromDD(val) {
  if (!val) return '';
  const m = String(val).match(/^(\d{1,2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2,4})$/i);
  if (m) {
    const months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
    const mon = months[m[2].toLowerCase()];
    let yr = m[3]; if (yr.length === 2) yr = '20' + yr;
    return yr + '-' + mon + '-' + String(parseInt(m[1])).padStart(2,'0');
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  return val;
}
function parseDDMonYY(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d{1,2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2,4})$/i);
  if (!m) return null;
  const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  let yr = parseInt(m[3]); if (yr < 100) yr += yr < 50 ? 2000 : 1900;
  return new Date(yr, months[m[2].toLowerCase()], parseInt(m[1]));
}
