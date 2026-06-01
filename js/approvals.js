// ── APPROVALS ─────────────────────────────────────────────────────────────
// Admin-only: view pending submissions, approve or reject them.

function renderMySubs() {
  const mine = S.pending.filter(p => p.submittedBy === S.cu.id).reverse();
  $('my-subs-list').innerHTML = mine.length
    ? mine.map(p => subCard(p, false)).join('')
    : '<div class="empty">No submissions yet.</div>';
}

function renderApprovals() {
  const pend = S.pending.filter(p => p.status === 'pending').reverse();
  $('approvals-list').innerHTML = pend.length
    ? pend.map(p => subCard(p, true)).join('')
    : '<div class="empty">No pending approvals 🎉</div>';
}

function approve(id) {
  const item = S.pending.find(p => p.id === id);
  if (!item) return;
  item.status = 'approved';

  if (item.type === 'loan') {
    S.loans.push({
      loanId: item.data.loanId,
      data: item.data,
      emis: [],
      approvedAt: new Date().toISOString(),
      closed: false,
    });
  } else {
    const loan = S.loans.find(l => l.loanId === item.data.loanId);
    if (loan) {
      loan.emis.push({
        emiNum: item.data.emiNum,
        amount: item.data.amount,
        date: item.data.date,
        mode: item.data.mode,
        reason: item.data.reason,
        notes: item.data.notes,
      });
      if (loan.emis.length >= loan.data.tenure) loan.closed = true;
    }
    S.emis.push({ ...item.data, approvedAt: new Date().toISOString() });
  }

  renderApprovals();
  refreshNav();
  showAlert('Entry approved and recorded.');
}

function reject(id) {
  const note = prompt('Reason for rejection (optional):') || '';
  const item = S.pending.find(p => p.id === id);
  if (!item) return;
  item.status = 'rejected';
  item.note = note;
  renderApprovals();
  refreshNav();
  showAlert('Entry rejected.', 'e');
}

function subCard(p, showActions) {
  const user = S.users.find(u => u.id === p.submittedBy);
  const date = new Date(p.submittedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const bc   = p.status === 'pending' ? 'b-pending' : p.status === 'approved' ? 'b-approved' : 'b-rejected';

  let detail = '';
  if (p.type === 'loan') {
    const d = p.data;
    detail = `<div class="kv">
      <span class="kv-l">Loan ID</span><span class="kv-v" style="color:#534AB7">${d.loanId}</span>
      <span class="kv-l">Customer</span><span class="kv-v">${d.customerName}</span>
      <span class="kv-l">Phone</span><span class="kv-v">${d.phone}</span>
      <span class="kv-l">Aadhaar/PAN</span><span class="kv-v">${d.idNum}</span>
      <span class="kv-l">Model</span><span class="kv-v">${d.model} (${d.deviceType})</span>
      <span class="kv-l">Device price</span><span class="kv-v">${fmt(d.price)}</span>
      <span class="kv-l">Down payment</span><span class="kv-v">${fmt(d.downPayment)}</span>
      <span class="kv-l">Processing fee</span><span class="kv-v">${fmt(d.processingFee)}</span>
      <span class="kv-l">App lock</span><span class="kv-v">${fmt(d.appLockCharge)}</span>
      <span class="kv-l">Interest</span><span class="kv-v">${fmt(d.interest)}</span>
      <span class="kv-l">Finance amount</span><span class="kv-v">${fmt(d.financeAmount)}</span>
      <span class="kv-l">Total amount</span><span class="kv-v">${fmt(d.totalAmount)}</span>
      <span class="kv-l">Monthly EMI</span><span class="kv-v">${fmt(d.monthlyEmi)}</span>
      <span class="kv-l">Tenure</span><span class="kv-v">${d.tenure} months</span>
      <span class="kv-l">EMI start</span><span class="kv-v">${d.emiStart || '—'}</span>
      <span class="kv-l">Rate of interest</span><span class="kv-v" style="color:#BA7517">${d.rateOfInterest ? d.rateOfInterest + '%' : '—'}</span>
      <span class="kv-l">AK / AKS share</span><span class="kv-v">${d.akShare}% / ${d.aksShare}%</span>
      <span class="kv-l">AK amount</span><span class="kv-v">${fmt(d.akAmount)}</span>
      <span class="kv-l">AKS amount</span><span class="kv-v">${fmt(d.aksAmount)}</span>
      ${d.guarantor ? `<span class="kv-l">Guarantor</span><span class="kv-v">${d.guarantor}</span>` : ''}
    </div>`;
  } else {
    const d = p.data;
    const diff = d.amount - d.expectedAmount;
    detail = `<div class="kv">
      <span class="kv-l">Loan ID</span><span class="kv-v" style="color:#534AB7">${d.loanId}</span>
      <span class="kv-l">Customer</span><span class="kv-v">${d.customerName}</span>
      <span class="kv-l">EMI number</span><span class="kv-v">EMI ${d.emiNum}</span>
      <span class="kv-l">Expected</span><span class="kv-v">${fmt(d.expectedAmount)}</span>
      <span class="kv-l">Received</span><span class="kv-v" style="${Math.abs(diff) > 1 ? 'color:#BA7517' : 'color:#27500A'}">${fmt(d.amount)}${Math.abs(diff) > 1 ? ` (${diff > 0 ? '+' : ''}${fmt(Math.abs(diff))})` : ''}</span>
      ${d.reason ? `<span class="kv-l">Reason</span><span class="kv-v">${d.reason}</span>` : ''}
      <span class="kv-l">Payment date</span><span class="kv-v">${d.date}</span>
      <span class="kv-l">Mode</span><span class="kv-v">${d.mode}</span>
      ${d.notes ? `<span class="kv-l">Notes</span><span class="kv-v">${d.notes}</span>` : ''}
    </div>`;
  }

  const actions = showActions && p.status === 'pending'
    ? `<div style="display:flex;gap:8px;margin-top:0.75rem;padding-top:0.75rem;border-top:0.5px solid #eee">
        <button class="btn btn-success btn-sm" onclick="approve('${p.id}')">✓ Approve</button>
        <button class="btn btn-danger btn-sm" onclick="reject('${p.id}')">✗ Reject</button>
       </div>`
    : p.note ? `<div style="font-size:12px;color:#A32D2D;margin-top:0.5rem">Rejection note: ${p.note}</div>` : '';

  return `<div class="card">
    <div class="card-hd">
      <div>
        <span class="tag ${p.type === 'loan' ? 't-loan' : 't-emi'}">${p.type === 'loan' ? 'New loan' : 'EMI payment'}</span>
        <div class="card-title" style="margin-top:4px">${p.type === 'loan' ? p.data.loanId : `${p.data.loanId} · EMI ${p.data.emiNum}`}</div>
        <div class="card-sub">By ${user?.name || 'Unknown'} · ${date}</div>
      </div>
      <span class="badge ${bc}">${p.status}</span>
    </div>
    ${detail}${actions}
  </div>`;
}
