// ── APPROVALS ─────────────────────────────────────────────────────────────
// Submissions stored in Unapproved_Loan / Unapproved_EMI sheets.
// Approved → appended to Input / logged EMI sheets, deleted from unapproved.
// Rejected → status updated in unapproved sheet, kept for reference.

// ── Fetch pending from both unapproved sheets ─────────────────────────────
async function fetchPendingFromSheets() {
  if (!S.sheetsUrl) return;
  try {
    const res  = await fetch(S.sheetsUrl + '?action=readPending');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    // Merge with any locally submitted items not yet in Sheets
    const sheetsIds = new Set(data.pending.map(p => p.id));
    const localOnly = S.pending.filter(p => !sheetsIds.has(p.id));
    S.pending = [...data.pending, ...localOnly];
    refreshNav();
    if (S.page === 'approvals') renderApprovals();
    if (S.page === 'my-subs')   renderMySubs();
  } catch(err) { console.warn('fetchPending error:', err.message); }
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
  await fetch(S.sheetsUrl, { method:'POST', body: form });
}

// ── My Submissions ────────────────────────────────────────────────────────
function renderMySubs() {
  const mine = S.pending.filter(p => p.submittedBy === S.cu.id).reverse();
  $('my-subs-list').innerHTML = mine.length
    ? mine.map(p => subCard(p, false)).join('')
    : '<div class="empty">No submissions yet.</div>';
}

// ── Approvals: two-column layout ──────────────────────────────────────────
function renderApprovals() {
  const loans = S.pending.filter(p => p.status === 'pending' && p.type === 'loan').reverse();
  const emis  = S.pending.filter(p => p.status === 'pending' && p.type === 'emi').reverse();
  $('approvals-loans').innerHTML = loans.length
    ? loans.map(p => subCard(p, true)).join('')
    : '<div class="empty">No pending loans 🎉</div>';
  $('approvals-emis').innerHTML  = emis.length
    ? emis.map(p  => subCard(p, true)).join('')
    : '<div class="empty">No pending EMIs 🎉</div>';
  $('appr-loan-count').textContent = loans.length;
  $('appr-emi-count').textContent  = emis.length;
}

// ── Approve ───────────────────────────────────────────────────────────────
async function approve(id) {
  const item = S.pending.find(p => p.id === id);
  if (!item) return;

  // Optimistically update UI
  item.status = 'approved';
  renderApprovals();
  refreshNav();
  showAlert('Approving…', 'w');

  try {
    const res  = await fetch(S.sheetsUrl, {
      method:'POST', mode:'no-cors',
      body: form,
    });
    showAlert('Approved and saved to Sheets ✓');
  } catch(err) {
    showAlert('Approved locally but Sheets sync failed: ' + err.message, 'w');
  }
}

// ── Reject ────────────────────────────────────────────────────────────────
async function reject(id) {
  const note = prompt('Reason for rejection (optional):') || '';
  const item = S.pending.find(p => p.id === id);
  if (!item) return;
  item.status = 'rejected';
  item.note   = note;
  renderApprovals();
  refreshNav();
  try {
    await fetch(S.sheetsUrl, {
      method:'POST', mode:'no-cors',
      body: form,
    });
    showAlert('Entry rejected.', 'e');
  } catch(err) {
    showAlert('Rejected locally but Sheets sync failed.', 'w');
  }
}

// ── Edit ──────────────────────────────────────────────────────────────────
function editSubmission(id) {
  const item = S.pending.find(p => p.id === id);
  if (!item) return;
  S.editingId = id;
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
         + editField('Bill date',        'ed-billdate', d.billDate, 'date')
         + editField('Model',            'ed-model',    d.model)
         + editField('Device type',      'ed-dtype',    d.deviceType)
         + editField('Device amount ₹',  'ed-price',    d.price,    'number')
         + editField('Down payment ₹',   'ed-down',     d.downPayment, 'number')
         + editField('Processing fee ₹', 'ed-pfee',     d.processingFee, 'number')
         + editField('App lock ₹',       'ed-applock',  d.appLockCharge, 'number')
         + editField('EMI duration',     'ed-tenure',   d.tenure,   'number')
         + editField('Monthly EMI ₹',    'ed-emi',      d.monthlyEmi, 'number')
         + editField('Interest ₹',       'ed-int',      d.interest, 'number')
         + editField('EMI start date',   'ed-emistart', d.emiStart, 'date')
         + editField('AK share %',       'ed-akshare',  d.akShare,  'number')
         + editField('Guarantor',        'ed-guar',     d.guarantor);
  } else {
    html = editField('Loan ID',        'ed-loanid',   d.loanId)
         + editField('EMI number',     'ed-eminum',   d.emiNum,   'number')
         + editField('Amount ₹',       'ed-amount',   d.amount,   'number')
         + editField('Payment date',   'ed-date',     d.date,     'date')
         + editField('Payment mode',   'ed-mode',     d.mode)
         + editField('Notes',          'ed-notes',    d.notes);
  }
  $('edit-modal-fields').innerHTML = html;
}

function editField(label, id, value, type='text') {
  return `<div style="margin-bottom:0.6rem">
    <label style="font-size:12px;color:#666;display:block;margin-bottom:3px">${label}</label>
    <input type="${type}" id="${id}" value="${value||''}" style="width:100%;padding:8px 10px;border:0.5px solid #ccc;border-radius:8px;font-size:13px">
  </div>`;
}

function saveEdit() {
  const id   = S.editingId;
  const item = S.pending.find(p => p.id === id);
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
    d.loanId  = $('ed-loanid').value.trim();
    d.emiNum  = parseInt($('ed-eminum').value)||d.emiNum;
    d.amount  = parseFloat($('ed-amount').value)||0;
    d.date    = $('ed-date').value;
    d.mode    = $('ed-mode').value.trim();
    d.notes   = $('ed-notes').value.trim();
  }

  closeEditModal();
  renderApprovals();
  showAlert('Entry updated.');

  // Sync edit to Sheets
  if (S.sheetsUrl) {
    fetch(S.sheetsUrl, {
      method:'POST', mode:'no-cors',
      body: form,
    }).catch(err => console.warn('updatePending error:', err.message));
  }
}

function closeEditModal() {
  $('edit-modal').style.display = 'none';
  S.editingId = null;
}

// ── Submission card ───────────────────────────────────────────────────────
function subCard(p, showActions) {
  const user = S.users.find(u => u.id === p.submittedBy);
  const date = new Date(p.submittedAt).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'});
  const bc   = p.status==='pending'?'b-pending':p.status==='approved'?'b-approved':'b-rejected';

  let detail = '';
  if (p.type === 'loan') {
    const d = p.data;
    detail = `<div class="kv">
      <span class="kv-l">Loan ID</span>      <span class="kv-v" style="color:#534AB7">${d.loanId}</span>
      <span class="kv-l">Customer</span>     <span class="kv-v">${d.customerName}</span>
      <span class="kv-l">Phone</span>        <span class="kv-v">${d.phone}</span>
      <span class="kv-l">Aadhaar/PAN</span>  <span class="kv-v">${d.idNum}</span>
      <span class="kv-l">Model</span>        <span class="kv-v">${d.model} (${d.deviceType})</span>
      <span class="kv-l">Device price</span> <span class="kv-v">${fmt(d.price)}</span>
      <span class="kv-l">Down payment</span> <span class="kv-v">${fmt(d.downPayment)}</span>
      <span class="kv-l">Processing fee</span><span class="kv-v">${fmt(d.processingFee)}</span>
      <span class="kv-l">App lock</span>     <span class="kv-v">${fmt(d.appLockCharge)}</span>
      <span class="kv-l">Finance amount</span><span class="kv-v">${fmt(d.financeAmount)}</span>
      <span class="kv-l">Interest</span>     <span class="kv-v">${fmt(d.interest)}</span>
      <span class="kv-l">Monthly EMI</span>  <span class="kv-v">${fmt(d.monthlyEmi)}</span>
      <span class="kv-l">Tenure</span>       <span class="kv-v">${d.tenure} months</span>
      <span class="kv-l">EMI start</span>    <span class="kv-v">${d.emiStart||'—'}</span>
      <span class="kv-l">Rate of interest</span><span class="kv-v" style="color:#BA7517">${d.rateOfInterest?d.rateOfInterest+'%':'—'}</span>
      <span class="kv-l">AK / AKS</span>    <span class="kv-v">${d.akShare}% / ${d.aksShare}%</span>
      ${d.guarantor?`<span class="kv-l">Guarantor</span><span class="kv-v">${d.guarantor}</span>`:''}
    </div>`;
  } else {
    const d = p.data, diff = d.amount - d.expectedAmount;
    detail = `<div class="kv">
      <span class="kv-l">Loan ID</span>     <span class="kv-v" style="color:#534AB7">${d.loanId}</span>
      <span class="kv-l">Customer</span>    <span class="kv-v">${d.customerName}</span>
      <span class="kv-l">EMI number</span>  <span class="kv-v">EMI ${d.emiNum}</span>
      <span class="kv-l">Expected</span>    <span class="kv-v">${fmt(d.expectedAmount)}</span>
      <span class="kv-l">Received</span>    <span class="kv-v" style="${Math.abs(diff)>1?'color:#BA7517':'color:#27500A'}">${fmt(d.amount)}${Math.abs(diff)>1?` (${diff>0?'+':''}${fmt(Math.abs(diff))})`:''}</span>
      ${d.reason?`<span class="kv-l">Reason</span><span class="kv-v">${d.reason}</span>`:''}
      <span class="kv-l">Payment date</span><span class="kv-v">${d.date}</span>
      <span class="kv-l">Mode</span>        <span class="kv-v">${d.mode}</span>
      ${d.notes?`<span class="kv-l">Notes</span><span class="kv-v">${d.notes}</span>`:''}
    </div>`;
  }

  const actions = showActions && p.status === 'pending'
    ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:0.75rem;padding-top:0.75rem;border-top:0.5px solid #eee">
        <button class="btn btn-success btn-sm" onclick="approve('${p.id}')">✓ Approve</button>
        <button class="btn btn-sm" style="color:#534AB7;border-color:#534AB7" onclick="editSubmission('${p.id}')">✎ Edit</button>
        <button class="btn btn-danger btn-sm"  onclick="reject('${p.id}')">✗ Reject</button>
       </div>`
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
    ${detail}${actions}
  </div>`;
}
