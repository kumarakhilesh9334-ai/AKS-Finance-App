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
  payload._pin    = S.cu ? S.cu.pin : '';
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

// Authenticated GET helper — auto-injects _userId and _pin as query params.
// Identical concurrent GETs share one in-flight request instead of doubling up.
// Pass { signal } to make the request abortable (see preemptFullLoadRetry) — an
// aborted request never consumes a retry attempt, since the abort is deliberate.
// Pass { priority } to choose its slot in the transport queue (see PRIORITY).
const _inflightGets = {};
async function gasGet(action, params = {}, opts = {}) {
  params.action = action;
  params._userId = S.cu ? S.cu.id : '';
  params._pin    = S.cu ? S.cu.pin : '';
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

function populateEditModal(item) {
  const d = item.data;
  $('edit-modal-title').textContent = item.type === 'loan'
    ? 'Edit loan: ' + d.loanId
    : 'Edit EMI: ' + d.loanId + ' · EMI ' + d.emiNum;

  let html = '';
  if (item.type === 'loan') {
    html = editField('Customer name',    'ed-cname',    d.customerName)
         + editField('Phone',            'ed-phone',    d.phone)
         + editField('Aadhaar/PAN',      'ed-idnum',    d.idNum)
         + editField('Bill date',        'ed-billdate', ymdFromDD(d.billDate), 'date')
         + editField('Model',            'ed-model',    d.model)
         + editField('Device type',      'ed-dtype',    d.deviceType)
         + editField('Device amount ₹',  'ed-price',    d.price,    'number')
         + editField('Down payment ₹',   'ed-down',     d.downPayment, 'number')
         + editField('Processing fee ₹', 'ed-pfee',     d.processingFee, 'number')
         + editField('App lock ₹',       'ed-applock',  d.appLockCharge, 'number')
         + editField('EMI duration',     'ed-tenure',   d.tenure,   'number')
         + editField('Monthly EMI ₹',    'ed-emi',      d.monthlyEmi, 'number')
         + editField('Interest ₹',       'ed-int',      d.interest, 'number')
         + editField('EMI start date',   'ed-emistart', ymdFromDD(d.emiStart), 'date')
         + editField('AK share %',       'ed-akshare',  d.akShare,  'number')
         + editField('Guarantor',        'ed-guar',     d.guarantor);
  } else {
    html = editField('Loan ID',        'ed-loanid',   d.loanId)
         + editField('Customer name',  'ed-cname',    d.customerName)
         + editField('Mobile model',   'ed-model',    d.model)
         + editField('EMI number',     'ed-eminum',   d.emiNum,   'number')
         + editField('EMI start date', 'ed-emistart', ymdFromDD(d.emiStartDate), 'date')
         + editField('Expected ₹',     'ed-expamt',   d.expectedAmount, 'number')
         + editField('Received ₹',     'ed-amount',   d.amount,   'number')
         + editField('Payment date',   'ed-date',     ymdFromDD(d.date), 'date')
         + editField('Reason',         'ed-misctype', d.miscType || d.reason);
  }
  $('edit-modal-body').innerHTML = html;
}

function editField(label, id, value, type='text') {
  const val = value != null ? value : '';
  return `<div style="margin-bottom:0.6rem">
    <label style="font-size:12px;color:#666;display:block;margin-bottom:3px">${label}</label>
    <input type="${type}" id="${id}" value="${val}" style="width:100%;padding:8px 10px;border:0.5px solid #ccc;border-radius:8px;font-size:13px">
  </div>`;
}

async function saveEdit() {
  const id   = S.editingId;
  const type = S.editingType;
  const item = S.pending.find(p => p.id === id && (!type || p.type === type));
  if (!item) return;
  const d = item.data;

  if (item.type === 'loan') {
    d.customerName  = $('ed-cname').value.trim();
    d.phone         = $('ed-phone').value.trim();
    d.idNum         = $('ed-idnum').value.trim();
    d.billDate      = $('ed-billdate').value;
    d.model         = $('ed-model').value.trim();
    d.deviceType    = $('ed-dtype').value.trim();
    d.price         = parseFloat($('ed-price').value)||0;
    d.downPayment   = parseFloat($('ed-down').value)||0;
    d.processingFee = parseFloat($('ed-pfee').value)||0;
    d.appLockCharge = parseFloat($('ed-applock').value)||0;
    d.tenure        = parseFloat($('ed-tenure').value)||0;
    d.monthlyEmi    = parseFloat($('ed-emi').value)||0;
    d.interest      = parseFloat($('ed-int').value)||0;
    d.emiStart      = $('ed-emistart').value;
    d.akShare       = parseFloat($('ed-akshare').value)||0;
    d.aksShare      = 100 - d.akShare;
    d.guarantor     = $('ed-guar').value.trim();
    d.financeAmount = d.price - d.downPayment + d.appLockCharge;
    d.totalAmount   = d.financeAmount + d.processingFee + d.interest;
    d.akAmount      = Math.round(d.financeAmount * d.akShare  / 100);
    d.aksAmount     = Math.round(d.financeAmount * d.aksShare / 100);
  } else {
    d.loanId        = $('ed-loanid').value.trim();
    d.customerName  = $('ed-cname').value.trim();
    d.model         = $('ed-model').value.trim();
    d.emiNum        = parseInt($('ed-eminum').value)||d.emiNum;
    d.emiStartDate  = $('ed-emistart').value;
    d.expectedAmount= parseFloat($('ed-expamt').value)||0;
    d.amount        = parseFloat($('ed-amount').value)||0;
    d.misc          = d.amount - d.expectedAmount;
    d.date          = $('ed-date').value;
    d.miscType      = $('ed-misctype').value.trim();
    d.reason        = d.miscType;
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
