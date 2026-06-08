// ── APPROVALS ─────────────────────────────────────────────────────────────
// Submissions stored in Unapproved_Loan / Unapproved_EMI sheets.
// Approved → appended to Input / logged EMI sheets, deleted from unapproved.
// Rejected → status updated in unapproved sheet, kept for reference.

// ── Fetch pending from both unapproved sheets ─────────────────────────────
async function fetchPendingFromSheets() {
  if (!S.sheetsUrl) return;
  try {
    const [res, res2] = await Promise.all([
      fetch(S.sheetsUrl + '?action=readPending'),
      fetch(S.sheetsUrl + '?action=readApprovedPartials'),
    ]);
    const data  = await res.json();
    const data2 = await res2.json();
    if (!data.ok) throw new Error(data.error);
    S.pending = data.pending;
    if (data2.ok && Array.isArray(data2.partials)) S.approvedPartials = data2.partials;
    refreshNav();
    // Always re-render these pages when data arrives — regardless of current page
    renderApprovals($('appr-search') ? $('appr-search').value : '');
    rerenderActiveTab();
  } catch(err) {
    console.warn('fetchPending error:', err.message);
    // Still re-render with whatever is in S.pending (may be empty)
    renderApprovals($('appr-search') ? $('appr-search').value : '');
  }
}

// ── Save new submission to Sheets ─────────────────────────────────────────
async function savePendingToSheets(item) {
  if (!S.sheetsUrl) return;
  try {
    await gasPost({action:'savePending', item});
  } catch(err) { console.warn('savePending error:', err.message); }
}

// Google Apps Script POST helper — uses a form submission trick to
// bypass CORS while still sending a parseable body.
// Apps Script receives the JSON in e.parameter.payload
async function gasPost(payload) {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  const res = await fetch(S.sheetsUrl, { method:'POST', body: form });
  return res.json();
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
    const fd = new FormData();
    fd.append('payload', JSON.stringify({action:'approvePending', id, type:item.type, data:item.data}));
    const res = await fetch(S.sheetsUrl, { method:'POST', body: fd }).then(r => r.json());
    if (!res.ok) {
      if (res.error === 'duplicate_emi') {
        showAlert('This EMI already exists in the logged EMI sheet!', 'e');
      } else {
        await fetchPendingFromSheets();
      }
    } else if (res.pending) S.pending = res.pending;
    else await fetchPendingFromSheets();
    await fetchApprovedPartials();
    refreshNav();
    renderApprovals($('appr-search') ? $('appr-search').value : '');
    rerenderActiveTab();
    if (res.ok) showAlert('Approved ✓');
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
    const fd = new FormData();
    fd.append('payload', JSON.stringify({action:'rejectPending', id, type:item.type, note}));
    const res = await fetch(S.sheetsUrl, { method:'POST', body: fd }).then(r => r.json());
    if (res.ok && res.pending) S.pending = res.pending;
    else await fetchPendingFromSheets();
    await fetchApprovedPartials();
    refreshNav();
    renderApprovals($('appr-search') ? $('appr-search').value : '');
    rerenderActiveTab();
    showAlert('Entry rejected.', 'e');
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
         + editField('Reason',         'ed-misctype', d.miscType);
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
  }

  closeEditModal();
  showAlert('Saving…', 'w');
  showLoader();
  try {
    if (S.sheetsUrl) {
      const res = await gasPost({action:'updatePending', id, type:item.type, data:d});
      if (res.ok && res.pending) S.pending = res.pending;
      else await fetchPendingFromSheets();
    }
    await fetchApprovedPartials();
    refreshNav();
    renderApprovals($('appr-search') ? $('appr-search').value : '');
    rerenderActiveTab();
    showAlert('Entry updated.');
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
    detail = `<div class="kv">
      <span class="kv-l">Bill Date</span>    <span class="kv-v">${fmtDateDD(d.billDate)}</span>
      <span class="kv-l">Customer</span>     <span class="kv-v">${d.customerName}</span>
      <span class="kv-l">Phone</span>        <span class="kv-v">${d.phone}</span>
      <span class="kv-l">Aadhaar/PAN</span>  <span class="kv-v">${d.idNum}</span>
      <span class="kv-l">Model</span>        <span class="kv-v">${d.model}</span>
      <span class="kv-l">Device Type</span>  <span class="kv-v">${d.deviceType}</span>
      <span class="kv-l">Device amount</span><span class="kv-v">${fmt(d.price)}</span>
      <span class="kv-l">Down payment</span> <span class="kv-v">${fmt(d.downPayment)}</span>
      <span class="kv-l">Processing fee</span><span class="kv-v">${fmt(d.processingFee)}</span>
      <span class="kv-l">Interest</span>     <span class="kv-v">${fmt(d.interest)}</span>
      <span class="kv-l">EMI duration</span> <span class="kv-v">${d.tenure} months</span>
      <span class="kv-l">Monthly EMI</span>  <span class="kv-v">${fmt((d.price - d.downPayment + d.processingFee + d.interest) / (d.tenure||1))}</span>
      <span class="kv-l">EMI start</span>    <span class="kv-v">${fmtDateDD(d.emiStart)}</span>
      <span class="kv-l">App lock</span>     <span class="kv-v">${fmt(d.appLockCharge)}</span>
      <span class="kv-l">AK share</span>     <span class="kv-v">${d.akShare}%</span>
      ${!hideRoi ? `<span class="kv-l">Rate of interest</span><span class="kv-v" style="color:#BA7517">${Math.round(d.rateOfInterest * 100)}%</span>` : ''}
      ${d.guarantor?`<span class="kv-l">Guarantor</span><span class="kv-v">${d.guarantor}</span>`:''}
    </div>`;
  } else {
    const d = p.data, diff = d.amount - d.expectedAmount;
    const loan = S.sheetLoans?.find(l => l.loanId === d.loanId);
    const extraRcv = loan ? (loan.extraEmiReceived||0) : 0;
    const adjExpected = Math.max(0, d.expectedAmount - extraRcv);
    detail = `<div class="kv">
      <span class="kv-l">Loan ID</span>     <span class="kv-v" style="color:#534AB7">${d.loanId}</span>
      <span class="kv-l">Customer</span>    <span class="kv-v">${d.customerName}</span>
      <span class="kv-l">Model</span>       <span class="kv-v">${d.model}</span>
      <span class="kv-l">EMI number</span>  <span class="kv-v">EMI ${d.emiNum}</span>
      <span class="kv-l">EMI start</span>   <span class="kv-v">${fmtDateDD(d.emiStartDate)}</span>
      <span class="kv-l">Std EMI</span>    <span class="kv-v">${fmt(d.expectedAmount)}</span>
      ${adjExpected!==d.expectedAmount?`<span class="kv-l">Expected</span><span class="kv-v">${fmt(adjExpected)}</span>`:''}
      <span class="kv-l">Received</span>    <span class="kv-v">${fmt(d.amount)}${Math.abs(diff)>1?` (${diff>0?'+':'–'}${fmt(Math.abs(diff))})`:''}</span>
      ${d.miscType?`<span class="kv-l">Reason</span><span class="kv-v">${d.miscType}</span>`:''}
      <span class="kv-l">Payment date</span><span class="kv-v">${fmtDateDD(d.date)}</span>
    </div>`;
  }

  const btns = {
    approve: '<button class="btn btn-success btn-sm" onclick="approve(\''+p.id+'\',\''+p.type+'\')">✓ Approve</button>',
    edit: '<button class="btn btn-sm" style="color:#534AB7;border-color:#534AB7" onclick="editSubmission(\''+p.id+'\',\''+p.type+'\')">✎ Edit</button>',
    reject: '<button class="btn btn-danger btn-sm"  onclick="reject(\''+p.id+'\',\''+p.type+'\')">✗ Reject</button>',
  };
  const actionList = showActions === true ? ['approve','edit','reject'] : (Array.isArray(showActions) ? showActions : []);
  const actionsHtml = actionList.length && p.status === 'pending'
    ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:0.75rem;padding-top:0.75rem;border-top:0.5px solid #eee">${actionList.map(a => btns[a]||'').join('')}</div>`
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
