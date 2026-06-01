// ── ALL LOANS (admin) ─────────────────────────────────────────────────────
// Shows all loans from Sheets master data with full details, sorted like EMI tab.

function renderLoans() {
  const q = (v('loan-search') || '').toLowerCase();
  const today = new Date(); today.setHours(0,0,0,0);
  const source = (S.sheetLoans && S.sheetLoans.length)
    ? S.sheetLoans
    : S.loans.map(l => ({ ...l.data, status: l.closed?'Closed':'Active', isDefaulted:false, emiCompleted:l.closed, slots:[], numReceivedEmi:l.emis.length }));

  const filtered = q ? source.filter(l =>
    l.loanId.toLowerCase().includes(q) ||
    (l.customerName||'').toLowerCase().includes(q) ||
    (l.phone||'').includes(q) ||
    (l.aadhaarPan||'').includes(q)
  ) : source;

  filtered.sort((a,b) => loanSort(today, a, b));

  if (!filtered.length) { $('loans-list').innerHTML = '<div class="empty">No loans found.</div>'; return; }

  $('loans-list').innerHTML = filtered.map(l => {
    const status = getLoanStatus(l, today);
    const bc = { 'Overdue':'b-rejected','Upcoming':'b-active','Defaulted':'b-defaulted','Closed':'b-closed' }[status] || 'b-pending';
    const dueTxt  = l.nextEmiDate ? fmtD(l.nextEmiDate) : '—';
    const billTxt = l.billDate ? fmtD(l.billDate) : '—';
    const lateTxt = l.lateEmis ? `${l.lateEmis}/${l.numReceivedEmi} late` : '';
    const akPct   = l.akShare  != null ? Math.round((l.akShare  <= 1 ? l.akShare  * 100 : l.akShare))  : 0;
    const aksPct  = l.aksShare != null ? Math.round((l.aksShare <= 1 ? l.aksShare * 100 : l.aksShare)) : 0;
    const id = l.loanId.replace(/[^a-zA-Z0-9]/g,'_');

    // Full detail rows (hidden by default)
    const rows = [
      ['Bill date',          billTxt],
      ['Customer',           l.customerName],
      ['Phone',              l.phone],
      ['Aadhaar/PAN',        l.aadhaarPan],
      ['Model',              l.model],
      ['Device type',        l.deviceType],
      ['Device amount',      fmtM(l.mobileAmount)],
      ['Down payment',       fmtM(l.downPayment)],
      ['Processing fee',     fmtM(l.processingFee)],
      ['Interest',           fmtM(l.interest)],
      ['Rate of interest',   l.rateOfInterest ? l.rateOfInterest+'%' : '—'],
      ['Finance amount',     fmtM(l.financeAmount)],
      ['Total amount',       fmtM(l.totalAmount)],
      ['Monthly EMI',        fmtM(l.monthlyEmi)],
      ['Tenure',             l.emiDuration ? l.emiDuration+' months' : '—'],
      ['EMI start',          fmtD(l.emiStartDate)],
      ['Next EMI date',      fmtD(l.nextEmiDate)],
      ['Last EMI date',      fmtD(l.lastEmiDate)],
      ['EMIs received',      l.numReceivedEmi != null ? `${l.numReceivedEmi} / ${l.emiDuration||'—'}` : '—'],
      ['Late EMIs',          l.lateEmis ? `${l.lateEmis} / ${l.numReceivedEmi}` : '0'],
      ['Late payment fine',  fmtM(l.latePaymentFine)],
      ['Remaining principal',fmtM(l.remainingPrincipal)],
      ['Remaining interest', fmtM(l.remainingInterest)],
      ['Total pending',      fmtM(l.totalPending)],
      ['Received total',     fmtM(l.receivedTotal)],
      ['AK / AKS share',     `${akPct}% / ${aksPct}%`],
      ['AK amount',          fmtM(l.akAmount)],
      ['AKS amount',         fmtM(l.aksAmount)],
      ['Guarantor',          l.guarantor],
      ['Default comment',    l.defaultComment],
    ].filter(([,val]) => val && val !== '—' && val !== '₹0');

    return `<div class="loan-summary-card ${status.toLowerCase()}" onclick="toggleLoanDetail('${id}')">
      <div class="loan-card-top">
        <div>
          <span class="emi-card-id">${l.loanId}</span>
          <span class="badge ${bc}" style="margin-left:8px">${status}</span>
        </div>
        <span class="emi-card-date-big">${dueTxt}</span>
      </div>
      <div class="emi-card-name">${l.customerName}</div>
      <div class="emi-card-meta">
        ${billTxt !== '—' ? `<span style="font-size:11px;color:#888">Bill: ${billTxt}</span>` : ''}
        <span class="emi-amt-pill">${fmtM(l.monthlyEmi)}/mo</span>
        ${l.model ? `<span class="emi-model-pill">${l.model}</span>` : ''}
        ${lateTxt ? `<span class="emi-late-pill">⚠ ${lateTxt}</span>` : ''}
        <span class="loan-expand-hint" id="hint-${id}">▼ Details</span>
      </div>
      <div class="loan-detail-panel" id="detail-${id}" style="display:none">
        <div class="divider" style="margin:8px 0"></div>
        <div class="kv">
          ${rows.map(([label,val]) => `<span class="kv-l">${label}</span><span class="kv-v">${val}</span>`).join('')}
        </div>
      </div>
    </div>`;
  }).join('');
}

function toggleLoanDetail(id) {
  const panel = $('detail-' + id);
  const hint  = $('hint-'   + id);
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  if (hint) hint.textContent = open ? '▼ Details' : '▲ Hide';
}

function loanSort(today, a, b) {
  const rankA = getLoanRank(a, today), rankB = getLoanRank(b, today);
  if (rankA !== rankB) return rankA - rankB;
  if (rankA === 1) { // overdue: oldest first then loanId
    const d = new Date(a.nextEmiDate||'9999') - new Date(b.nextEmiDate||'9999');
    return d !== 0 ? d : a.loanId.localeCompare(b.loanId);
  }
  if (rankA === 2) { // upcoming: soonest first then loanId
    const d = new Date(a.nextEmiDate||'9999') - new Date(b.nextEmiDate||'9999');
    return d !== 0 ? d : a.loanId.localeCompare(b.loanId);
  }
  return a.loanId.localeCompare(b.loanId);
}


// ── EMI HISTORY ───────────────────────────────────────────────────────────
function renderEmiHist() {
  if (!S.emis.length) { $('emi-hist-list').innerHTML = '<div class="empty">No EMI payments recorded yet.</div>'; return; }
  $('emi-hist-list').innerHTML = [...S.emis].reverse().map(e => {
    const diff = e.amount - e.expectedAmount;
    return `<div class="card">
      <div class="card-hd">
        <div><div class="card-title" style="color:#534AB7">${e.loanId}</div>
        <div class="card-sub">${e.customerName} · ${e.model||''} · EMI ${e.emiNum}</div></div>
        <span class="badge b-approved">Received</span>
      </div>
      <div class="kv">
        <span class="kv-l">Expected</span><span class="kv-v">${fmtM(e.expectedAmount)}</span>
        <span class="kv-l">Received</span><span class="kv-v" style="${Math.abs(diff)>1?'color:#BA7517':''}">${fmtM(e.amount)}${Math.abs(diff)>1?` (${diff>0?'+':''}${fmtM(Math.abs(diff))})`:''}</span>
        ${e.reason?`<span class="kv-l">Reason</span><span class="kv-v">${e.reason}</span>`:''}
        <span class="kv-l">Date</span><span class="kv-v">${e.date}</span>
        <span class="kv-l">Mode</span><span class="kv-v">${e.mode}</span>
        ${e.notes?`<span class="kv-l">Notes</span><span class="kv-v">${e.notes}</span>`:''}
      </div>
    </div>`;
  }).join('');
}
