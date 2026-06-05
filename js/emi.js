// ── EMI ───────────────────────────────────────────────────────────────────
// Log EMI tab: two-column layout — Upcoming (left) | Overdue (right)
// Closed & Defaulted are on their own admin-only tab.

// ── Fetch loans from Sheets on login ─────────────────────────────────────
async function fetchLoansFromSheets(force) {
  if (!S.sheetsUrl) return;
  // Use cached data if available and not forced — renders instantly on tab switch
  if (!force && S.sheetLoans && S.sheetLoans.length > 0) {
    rerenderActiveTab();
    return;
  }
  const statusEl = $('emi-fetch-status');
  if (statusEl) { statusEl.textContent = 'Loading loans…'; statusEl.className = 'emi-fetch-status loading'; }
  try {
    const res  = await fetch(S.sheetsUrl + '?action=readLoansSlim');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Unknown error');
    S.sheetLoans = data.loans || [];
    if (statusEl) {
      statusEl.textContent = '✓ ' + S.sheetLoans.length + ' loans loaded.';
      statusEl.className = 'emi-fetch-status ok';
      setTimeout(() => { if ($('emi-fetch-status')) $('emi-fetch-status').textContent = ''; }, 3000);
    }
    rerenderActiveTab();
  } catch (err) {
    if (statusEl) { statusEl.textContent = '⚠ Could not load: ' + err.message; statusEl.className = 'emi-fetch-status warn'; }
    S.sheetLoans = [];
  }
}

function rerenderActiveTab() {
  if (S.page === 'emi')        renderEmiColumns($('emi-search') ? $('emi-search').value : '');
  if (S.page === 'all-loans')  renderClosedDefaulted($('cd-search') ? $('cd-search').value : '');
}

// ── Page init ─────────────────────────────────────────────────────────────
function populateEmiSelect() {
  $('emi-search').value = '';
  $('emi-detail').style.display = 'none';
  S.selectedEmiLoanId = null;
  // Show loading state immediately; fetchLoansFromSheets will re-render when done
  if (!S.sheetLoans || !S.sheetLoans.length) {
    $('col-upcoming-list').innerHTML = '<div class="emi-col-empty" style="color:#534AB7">Loading loans…</div>';
    $('col-overdue-list').innerHTML  = '<div class="emi-col-empty" style="color:#534AB7">Loading loans…</div>';
    $('col-upcoming-count').textContent = '…';
    $('col-overdue-count').textContent  = '…';
  } else {
    renderEmiColumns('');
  }
}

// ── Two-column renderer ───────────────────────────────────────────────────
function renderEmiColumns(query) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const q = (query || '').toLowerCase();

  const source = (S.sheetLoans && S.sheetLoans.length)
    ? S.sheetLoans
    : S.loans.map(l => ({
        loanId: l.loanId, customerName: l.data.customerName,
        monthlyEmi: l.data.monthlyEmi, nextEmiDate: '',
        status: l.closed ? 'Closed' : 'Active',
        isDefaulted: false, emiCompleted: l.closed,
        model: l.data.model, akShare: l.data.akShare / 100,
        aksShare: l.data.aksShare / 100, emiDuration: l.data.tenure,
        slots: l.emis.map((e, i) => ({ num: i+1, received: true, dueDate: e.date, misc: 0, cashflow: e.amount })),
        numReceivedEmi: l.emis.length, lateEmis: 0, latePaymentFine: 0,
      }));

  // Only active loans for this tab (not closed, not defaulted)
  const active = source.filter(l => !l.isDefaulted && !l.emiCompleted && l.status !== 'Closed');

  const filtered = q
    ? active.filter(l => l.loanId.toLowerCase().includes(q) || l.customerName.toLowerCase().includes(q))
    : active;

  const upcoming = [], overdue = [];
  filtered.forEach(l => {
    if (!l.nextEmiDate) { upcoming.push(l); return; }
    const due = new Date(l.nextEmiDate); due.setHours(0,0,0,0);
    if (due < today) overdue.push(l); else upcoming.push(l);
  });

  // Overdue: descending date (most overdue first), then ascending loanId
  overdue.sort((a, b) => {
    const diff = new Date(b.nextEmiDate||'0') - new Date(a.nextEmiDate||'0');
    return diff !== 0 ? diff : a.loanId.localeCompare(b.loanId);
  });
  // Upcoming: ascending date (soonest first), then ascending loanId
  upcoming.sort((a, b) => {
    const diff = new Date(a.nextEmiDate||'9999') - new Date(b.nextEmiDate||'9999');
    return diff !== 0 ? diff : a.loanId.localeCompare(b.loanId);
  });

  $('col-upcoming-count').textContent = upcoming.length;
  $('col-overdue-count').textContent  = overdue.length;
  // Sync mobile tab badges
  const muc = $('mob-upcoming-count'), moc = $('mob-overdue-count');
  if (muc) muc.textContent = upcoming.length;
  if (moc) moc.textContent = overdue.length;
  const noDataMsg = (!S.sheetLoans || !S.sheetLoans.length) ? '<div class="emi-col-empty">Fetching from Sheets…</div>' : '';
  $('col-upcoming-list').innerHTML = upcoming.length ? upcoming.map(l => emiCard(l, 'upcoming')).join('') : (noDataMsg || '<div class="emi-col-empty">No upcoming EMIs</div>');
  $('col-overdue-list').innerHTML  = overdue.length  ? overdue.map(l  => emiCard(l, 'overdue')).join('')  : (noDataMsg || '<div class="emi-col-empty">All clear ✓</div>');
}

function emiCard(l, type) {
  const dueTxt  = l.nextEmiDate ? fmtDisplayDate(l.nextEmiDate) : '—';
  const lateTxt = l.lateEmis ? l.lateEmis + '/' + l.numReceivedEmi + ' late' : '';
  const billTxt = l.billDate ? fmtDisplayDate(l.billDate) : '';

  const today = new Date(); today.setHours(0,0,0,0);
  let bg = '', border = '', textColor = '#1a1a1a', subColor = '#888', overdueLabel = '';

  if (type === 'overdue' && l.nextEmiDate) {
    const due = new Date(l.nextEmiDate); due.setHours(0,0,0,0);
    const days = Math.round((today - due) / 86400000);
    textColor = '#fff'; subColor = 'rgba(255,255,255,0.75)';
    if (days > 90) {
      bg = '#000000'; border = '#000000'; overdueLabel = '90+ days overdue';
    } else if (days > 30) {
      bg = '#980000'; border = '#980000'; overdueLabel = '30+ days overdue';
    } else {
      bg = '#dd7e6b'; border = '#dd7e6b'; overdueLabel = days + 'd overdue';
    }
  } else if (type === 'upcoming' && l.nextEmiDate) {
    const due = new Date(l.nextEmiDate); due.setHours(0,0,0,0);
    if (due.getTime() === today.getTime()) {
      bg = '#ff9900'; border = '#ff9900'; textColor = '#fff'; subColor = 'rgba(255,255,255,0.75)';
    }
  }

  const cardStyle = bg ? `background:${bg};border-left-color:${border};border-color:${border}` : '';
  const pillStyle = bg ? 'background:rgba(255,255,255,0.2);color:#fff' : '';

  return `<div class="emi-card ${type}" data-loanid="${l.loanId}" style="${cardStyle}">
    <div class="emi-card-top">
      <span class="emi-card-id" style="color:${textColor}">${l.loanId}</span>
      <div style="text-align:right">
        <div class="emi-card-date-big" style="color:${textColor}">${dueTxt}</div>
        ${overdueLabel ? `<div style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.85);margin-top:1px">${overdueLabel}</div>` : ''}
      </div>
    </div>
    <div class="emi-card-name" style="color:${textColor}">${l.customerName}</div>
    <div class="emi-card-meta">
      ${billTxt ? `<span style="font-size:11px;color:${subColor}">Bill: ${billTxt}</span>` : ''}
      <span class="emi-amt-pill" style="${pillStyle}">${fmtAmt(l.monthlyEmi)}/mo</span>
      ${l.model ? `<span class="emi-model-pill" style="${pillStyle}">${l.model}</span>` : ''}
      ${lateTxt ? `<span class="emi-late-pill" style="${pillStyle}">&#9888; ${lateTxt}</span>` : ''}
    </div>
  </div>`;
}

// ── Loan selection ────────────────────────────────────────────────────────
// Event delegation for emi-card clicks (safe with loanIds containing special chars)
document.addEventListener('click', function(e) {
  const card = e.target.closest('.emi-card[data-loanid]');
  if (card) {
    const loanId = card.dataset.loanid;
    if (!card.classList.contains('no-action')) selectEmiLoan(loanId);
  }
});

async function selectEmiLoan(loanId) {
  document.querySelectorAll('.emi-card').forEach(r => r.classList.remove('selected'));
  document.querySelectorAll(`.emi-card[data-loanid="${loanId}"]`).forEach(r => r.classList.add('selected'));
  S.selectedEmiLoanId = loanId;

  let loan = (S.sheetLoans && S.sheetLoans.find(l => l.loanId === loanId))
    || (() => { const l = S.loans.find(l => l.loanId === loanId); return l ? { ...l.data, status:'Active', slots:[], numReceivedEmi: l.emis.length } : null; })();
  if (!loan) return;

  // If we only have slim data, fetch full detail first
  if (loan._slim) {
    $('emi-detail').style.display = 'block';
    $('emi-kv').innerHTML = '<div style="color:#888;font-size:12px;padding:8px 0">Loading details…</div>';
    $('emi-slots-wrap').style.display = 'none';
    try {
      const res  = await fetch(S.sheetsUrl + '?action=readLoanDetail&loanId=' + encodeURIComponent(loanId));
      const data = await res.json();
      if (data.ok && data.loan) {
        // Update cache with full data
        const idx = S.sheetLoans.findIndex(l => l.loanId === loanId);
        if (idx !== -1) S.sheetLoans[idx] = data.loan;
        loan = data.loan;
      }
    } catch(e) { console.warn('Could not load detail:', e.message); }
  }

  const detail = $('emi-detail');
  detail.style.display = 'block';
  detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const akPct  = Math.round((loan.akShare  || 0) * 100);
  const aksPct = Math.round((loan.aksShare || 0) * 100);

  $('emi-kv').innerHTML = `
    <span class="kv-l">Loan ID</span>       <span class="kv-v" style="color:#534AB7">${loan.loanId}</span>
    <span class="kv-l">Customer</span>      <span class="kv-v">${loan.customerName}${loan.phone ? ' · '+loan.phone : ''}</span>
    ${loan.model ? `<span class="kv-l">Model</span><span class="kv-v">${loan.model}${loan.deviceType ? ' ('+loan.deviceType+')' : ''}</span>` : ''}
    <span class="kv-l">Monthly EMI</span>   <span class="kv-v">${fmtAmt(loan.monthlyEmi)}</span>
    <span class="kv-l">Tenure</span>        <span class="kv-v">${loan.emiDuration} months</span>
    <span class="kv-l">EMIs received</span> <span class="kv-v">${loan.numReceivedEmi} of ${loan.emiDuration}</span>
    ${loan.nextEmiDate ? `<span class="kv-l">Next EMI date</span><span class="kv-v">${fmtDisplayDate(loan.nextEmiDate)}</span>` : ''}
    ${loan.totalPending   ? `<span class="kv-l">Total pending</span><span class="kv-v" style="color:#A32D2D">${fmtAmt(loan.totalPending)}</span>` : ''}
    ${loan.lateEmis       ? `<span class="kv-l">Late EMIs</span><span class="kv-v" style="color:#BA7517">${loan.lateEmis}</span>` : ''}
    ${loan.latePaymentFine? `<span class="kv-l">Late fine</span><span class="kv-v">${fmtAmt(loan.latePaymentFine)}</span>` : ''}
    <span class="kv-l">AK / AKS</span>      <span class="kv-v">${akPct}% / ${aksPct}%</span>
    ${loan.guarantor ? `<span class="kv-l">Guarantor</span><span class="kv-v">${loan.guarantor}</span>` : ''}
  `;

  // EMI slots
  const duration = loan.emiDuration || 0;
  const slots    = loan.slots || [];
  let slotsHtml  = '';
  const today2 = new Date(); today2.setHours(0,0,0,0);
  for (let i = 0; i < duration && i < 8; i++) {
    const slot = slots[i] || { num:i+1, received:false, scheduledDate:'', receivedDate:'', misc:0, cashflow:0 };
    // scheduledDate = calculated due date; receivedDate = actual date payment was made
    const scheduledTxt = slot.scheduledDate ? fmtDisplayDate(slot.scheduledDate) : '—';
    const receivedTxt  = slot.receivedDate  ? fmtDisplayDate(slot.receivedDate)  : '—';
    if (slot.received) {
      const extraTxt = slot.misc !== 0
        ? ` <span style="color:${slot.misc>0?'#0F6E56':'#A32D2D'}">(${slot.misc>0?'+':''}${fmtAmt(slot.misc)})</span>`
        : '';
      const recdLabel = slot.receivedDate && slot.receivedDate !== '—' ? slot.receivedDate : '';
      slotsHtml += `<div class="emi-slot">
        <span>EMI ${i+1}</span>
        <span style="color:#27500A">
          ${fmtAmt(slot.cashflow)}${extraTxt}
          ${recdLabel ? '· Recd: ' + fmtDisplayDate(recdLabel) : ''}
          · Due: ${scheduledTxt}
        </span>
        <span class="badge b-approved">Received</span>
      </div>`;
    } else {
      const isNext = i === loan.numReceivedEmi;
      const isOvd  = slot.scheduledDate && new Date(slot.scheduledDate) < today2;
      slotsHtml += `<div class="emi-slot">
        <span>EMI ${i+1}</span>
        <span style="color:${isOvd?'#A32D2D':'#888'}">Due: ${scheduledTxt}${isOvd?' ⚠':''}</span>
        <span class="badge ${isNext?'b-pending':''}" style="${isNext?'':'color:#ccc;font-size:11px'}">${isNext?'Next due':'Pending'}</span>
      </div>`;
    }
  }
  $('emi-slots').innerHTML = slotsHtml;
  $('emi-slots-wrap').style.display = duration > 0 ? 'block' : 'none';

  const nextNum = loan.numReceivedEmi + 1;
  // Expected to collect = monthlyEmi - extraEmiReceived
  const extraReceived = loan.extraEmiReceived || 0;
  const expectedAmt   = Math.max(0, (loan.monthlyEmi || 0) - extraReceived);
  const labelTxt = nextNum > duration ? 'All EMIs collected!'
    : `Recording: EMI ${nextNum} of ${duration} · Standard EMI: ${fmtAmt(loan.monthlyEmi)}${extraReceived ? ' · Expected to collect: ' + fmtAmt(expectedAmt) : ''}`;
  $('emi-next-label').textContent = labelTxt;

  // Prefill with full monthly EMI (agent types what they actually received)
  $('emi-amt').value  = loan.monthlyEmi || '';
  // Default payment date = today
  $('emi-date').value = new Date().toISOString().split('T')[0];
  $('emi-notes').value  = '';
  $('emi-reason').value = '';
  $('emi-reason-wrap').style.display = 'none';
  $('emi-diff-warn').style.display   = 'none';
}

// ── Diff check ────────────────────────────────────────────────────────────
function checkEmiDiff() {
  const loanId = S.selectedEmiLoanId; if (!loanId) return;
  const loan = (S.sheetLoans && S.sheetLoans.find(l => l.loanId === loanId)) || S.loans.find(l => l.loanId === loanId);
  if (!loan) return;
  const extraRcvd = loan.extraEmiReceived || 0;
  const expected  = Math.max(0, (loan.monthlyEmi || loan?.data?.monthlyEmi || 0) - extraRcvd);
  const got      = parseFloat($('emi-amt').value) || 0;
  if (!got) return;
  const diff = got - expected;
  if (Math.abs(diff) > 1) {
    $('emi-reason-wrap').style.display = 'block';
    $('emi-diff-warn').style.display   = 'block';
    $('emi-diff-msg').textContent = `Differs from expected ${fmtAmt(expected)} by ${diff>0?'+':''}${fmtAmt(Math.abs(diff))}. Please select a reason.`;
  } else {
    $('emi-reason-wrap').style.display = 'none';
    $('emi-diff-warn').style.display   = 'none';
  }
}

// ── Submit ────────────────────────────────────────────────────────────────
function submitEmi() {
  const loanId = S.selectedEmiLoanId;
  if (!loanId) { showAlert('Please select a loan first.', 'e'); return; }
  const sheetLoan = S.sheetLoans && S.sheetLoans.find(l => l.loanId === loanId);
  const inAppLoan = S.loans.find(l => l.loanId === loanId);
  if (!sheetLoan && !inAppLoan) { showAlert('Loan data not found.', 'e'); return; }
  const amt  = parseFloat($('emi-amt').value) || 0;
  const date = v('emi-date');
  if (!amt || !date) { showAlert('Please enter amount and payment date.', 'e'); return; }
  const extraRcv = (sheetLoan ? sheetLoan.extraEmiReceived : 0) || 0;
  const expected = Math.max(0, (sheetLoan ? sheetLoan.monthlyEmi : inAppLoan.data.monthlyEmi) - extraRcv);
  if (Math.abs(amt - expected) > 1 && !v('emi-reason')) { showAlert('Please select a reason for the amount difference.', 'e'); return; }
  const numReceived = sheetLoan ? sheetLoan.numReceivedEmi : inAppLoan.emis.length;
  // Compute scheduled due date for this EMI number
  const emiNum       = numReceived + 1;
  const emiStartDate = sheetLoan ? sheetLoan.emiStartDate : (inAppLoan ? inAppLoan.data.emiStart : '');
  let scheduledDate  = '';
  if (emiStartDate) {
    // Parse start date and add (emiNum-1) months
    const parts = String(emiStartDate).match(/(\d{1,2})[\-\/](\w{3})[\-\/](\d{2,4})/);
    if (parts) {
      const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
      const mon = months[parts[2].toLowerCase()];
      let yr = parseInt(parts[3]); if (yr<100) yr += yr<50?2000:1900;
      const sd = new Date(yr, mon, parseInt(parts[1]));
      sd.setMonth(sd.getMonth() + (emiNum - 1));
      scheduledDate = sd.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'2-digit'}).replace(/ /g,'-');
    }
  }

  const receivedVal = $('emi-received') ? $('emi-received').value !== 'false' : true;
  const d = {
    loanId,
    customerName:   sheetLoan ? sheetLoan.customerName : inAppLoan.data.customerName,
    model:          sheetLoan ? sheetLoan.model        : inAppLoan.data.model,
    emiNum,
    amount:         amt, expectedAmount: expected, misc: amt - expected,
    date, scheduledDate, emiStartDate,
    received: receivedVal,
    mode: v('emi-mode'), reason: v('emi-reason'), notes: v('emi-notes'),
    akShare:  sheetLoan ? Math.round(sheetLoan.akShare  * 100) : inAppLoan.data.akShare,
    aksShare: sheetLoan ? Math.round(sheetLoan.aksShare * 100) : inAppLoan.data.aksShare,
  };
  const emiItem = { id: nextPid(), type: 'emi', data: d, submittedBy: S.cu.id, submittedAt: new Date().toISOString(), status: 'pending', note: '' };
  S.pending.push(emiItem);
  gasPost({action:'saveEmi', item:emiItem}); // persist to Unapproved_EMI sheet
  showAlert('EMI payment submitted for approval.');
  $('emi-detail').style.display = 'none';
  S.selectedEmiLoanId = null;
  document.querySelectorAll('.emi-card').forEach(r => r.classList.remove('selected'));
  if ($('emi-received')) $('emi-received').value = 'true';
  refreshNav();
}

// ── Closed & Defaulted tab (admin only) ───────────────────────────────────
function renderClosedDefaulted(query) {
  const q = ((query !== undefined ? query : v('cd-search')) || '').toLowerCase();
  const source = S.sheetLoans && S.sheetLoans.length ? S.sheetLoans
    : S.loans.map(l => ({ loanId: l.loanId, customerName: l.data.customerName,
        monthlyEmi: l.data.monthlyEmi, nextEmiDate: '', status: l.closed ? 'Closed' : 'Active',
        isDefaulted: false, emiCompleted: l.closed, model: l.data.model,
        akShare: l.data.akShare/100, aksShare: l.data.aksShare/100, emiDuration: l.data.tenure,
        slots: [], numReceivedEmi: l.emis.length, lateEmis: 0, latePaymentFine: 0 }));

  const running   = source.filter(l => !l.isDefaulted && !l.emiCompleted && l.status !== 'Closed');
  const closed    = source.filter(l => !l.isDefaulted && (l.emiCompleted || l.status === 'Closed'));
  const defaulted = source.filter(l => l.isDefaulted);

  const match = l => !q || l.loanId.toLowerCase().includes(q) || (l.customerName||'').toLowerCase().includes(q);
  const fRunning   = running.filter(match);
  const fClosed    = closed.filter(match);
  const fDefaulted = defaulted.filter(match);

  $('cd-running-count').textContent   = fRunning.length;
  $('cd-closed-count').textContent    = fClosed.length;
  $('cd-defaulted-count').textContent = fDefaulted.length;

  const loading = '<div class="emi-col-empty" style="color:#534AB7">Loading…</div>';
  const cdNoData = (!S.sheetLoans || !S.sheetLoans.length);
  $('cd-running-list').innerHTML   = fRunning.length   ? fRunning.map(l   => cdCard(l, 'running')).join('')   : (cdNoData ? loading : '<div class="emi-col-empty">No running loans</div>');
  $('cd-closed-list').innerHTML    = fClosed.length    ? fClosed.map(l    => cdCard(l, 'closed')).join('')    : (cdNoData ? loading : '<div class="emi-col-empty">No closed loans</div>');
  $('cd-defaulted-list').innerHTML = fDefaulted.length ? fDefaulted.map(l => cdCard(l, 'defaulted')).join('') : (cdNoData ? loading : '<div class="emi-col-empty">No defaulted loans</div>');
}

function cdCard(l, type) {
  const lastDate = l.lastEmiDate ? fmtDisplayDate(l.lastEmiDate) : '—';
  return `<div class="emi-card ${type}" data-loanid="${l.loanId}" data-type="${type}" onclick="openCdDetail('${l.loanId}')" style="cursor:pointer">
    <div class="emi-card-top">
      <span class="emi-card-id">${l.loanId}</span>
      <span class="badge ${type === 'running' ? 'b-active' : type === 'closed' ? 'b-closed' : 'b-defaulted'}">${type}</span>
    </div>
    <div class="emi-card-name">${l.customerName}</div>
    <div class="emi-card-meta">
      <span class="emi-amt-pill">${fmtAmt(l.monthlyEmi)}/mo</span>
      ${l.model ? `<span class="emi-model-pill">${l.model}</span>` : ''}
    </div>
    <div class="emi-card-date">
      ${type === 'running'   ? (l.nextEmiDate ? 'Next EMI: ' + fmtDisplayDate(l.nextEmiDate) : '') :
        type === 'closed'    ? 'Last EMI: ' + lastDate :
        (l.defaultComment || 'Defaulted')}
    </div>
  </div>`;
}

function cdFmt(n) { return (n==null||n===''||n===0) ? '—' : '₹'+Number(n).toLocaleString('en-IN'); }

async function openCdDetail(loanId) {
  // Highlight selected card
  document.querySelectorAll('#page-closed-defaulted .emi-card').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll(`#page-closed-defaulted .emi-card[data-loanid="${loanId}"]`).forEach(c => c.classList.add('selected'));

  let l = S.sheetLoans && S.sheetLoans.find(x => x.loanId === loanId);
  if (!l) return;

  // If slim, show panel immediately with loading state then fetch full
  if (l._slim) {
    $('cd-detail-panel').style.display = 'block';
    $('cd-detail-loanid').textContent = loanId;
    $('cd-detail-sub').textContent    = l.customerName;
    $('cd-detail-kv').innerHTML = '<div style="color:#888;font-size:12px;padding:8px 0">Loading full details…</div>';
    $('cd-detail-panel').scrollIntoView({ behavior:'smooth', block:'nearest' });
    try {
      const res  = await fetch(S.sheetsUrl + '?action=readLoanDetail&loanId=' + encodeURIComponent(loanId));
      const data = await res.json();
      if (data.ok && data.loan) {
        const idx = S.sheetLoans.findIndex(x => x.loanId === loanId);
        if (idx !== -1) S.sheetLoans[idx] = data.loan;
        l = data.loan;
      }
    } catch(e) { console.warn('Could not load detail:', e.message); }
  }

  const akPct  = l.akShare  != null ? Math.round((l.akShare  <= 1 ? l.akShare  * 100 : l.akShare))  : 0;
  const aksPct = l.aksShare != null ? Math.round((l.aksShare <= 1 ? l.aksShare * 100 : l.aksShare)) : 0;

  // All 87 columns — show every field, blank shown as '—'
  const D = (v) => v || '—';
  const M = (v) => (v == null || v === '' || v === 0) ? '—' : '₹' + Number(v).toLocaleString('en-IN');
  const Dt = (v) => v ? fmtDisplayDate(v) : '—';
  const Pct = (v) => v != null && v !== '' ? v + '%' : '—';
  const Bool = (v) => v === true ? 'Yes' : v === false ? 'No' : '—';

  const rows = [
    ['Bill Date',                    Dt(l.billDate)],
    ['Loan ID',                      D(l.loanId)],
    ['Customer Name',                D(l.customerName)],
    ['Customer Mobile No',           D(l.phone)],
    ['Customer AADHAR / PAN',        D(l.aadhaarPan)],
    ['Mobile Model',                 D(l.model)],
    ['Device Type',                  D(l.deviceType)],
    ['Mobile Amount',                M(l.mobileAmount)],
    ['Down Payment',                 M(l.downPayment)],
    ['Processing Fee',               M(l.processingFee)],
    ['Interest',                     M(l.interest)],
    ['EMI Duration',                 l.emiDuration ? l.emiDuration + ' months' : '—'],
    ['EMI Start Date',               Dt(l.emiStartDate)],
    ['Total Amount',                 M(l.totalAmount)],
    ['Total EMI',                    D(l.totalEmi)],
    ['Monthly EMI',                  M(l.monthlyEmi)],
    ['Customer ID',                  D(l.customerId)],
    ['Guarantor / Alternate No',     D(l.guarantor)],
    ['Max Interest Discount',        M(l.maxInterestDiscount)],
    ['Rate of Interest',             Pct(l.rateOfInterest)],
    ['Finance Amount',               M(l.financeAmount)],
    ['App Lock Charge',              M(l.appLockCharge)],
    ['AK Share',                     akPct + '%'],
    ['AKS Share',                    aksPct + '%'],
    ['AK Amount',                    M(l.akAmount)],
    ['AK Paid to Kunal',             M(l.akPaidToKunal)],
    ['AKS Amount',                   M(l.aksAmount)],
    ['AKS Paid to Kunal',            M(l.aksPaidToKunal)],
    ['Next EMI Date',                Dt(l.nextEmiDate)],
    ['Last EMI Date',                Dt(l.lastEmiDate)],
    ['Remaining Principal',          M(l.remainingPrincipal)],
    ['Remaining Interest',           M(l.remainingInterest)],
    ['Total Pending',                M(l.totalPending)],
    ['Received Principal',           M(l.receivedPrincipal)],
    ['Received Interest',            M(l.receivedInterest)],
    ['Received Total',               M(l.receivedTotal)],
    ['Number of Received EMI',       D(l.numReceivedEmi)],
    ['EMI Completed',                Bool(l.emiCompleted)],
    ['Late EMIs',                    D(l.lateEmis)],
    ['Late Payment Fine',            M(l.latePaymentFine)],
    ['Early Loan Closing Settlement',M(l.earlyClosing)],
    ['Extra EMI Received',           M(l.extraEmiReceived)],
    ['Recovery Charge',              M(l.recoveryCharge)],
    ['Welcome Message Sent',         Bool(l.welcomeMsg)],
    ['Loan Closing Message Sent',    Bool(l.closingMsg)],
    ['Lock App Removed',             Bool(l.lockRemoved)],
    ['Defaulted',                    Bool(l.isDefaulted)],
    ['Default Comment',              D(l.defaultComment)],
    ['Final ROI',                    Pct(l.finalRoi)],
    // EMI slots
    ...( (l.slots||[]).flatMap((s,i) => [
      ['EMI ' + (i+1) + ' Received',   Bool(s.received)],
      ['EMI ' + (i+1) + ' Due Date',   s.scheduledDate ? fmtDisplayDate(s.scheduledDate) : '—'],
      ['EMI ' + (i+1) + ' Rcvd Date',  s.receivedDate  ? fmtDisplayDate(s.receivedDate)  : '—'],
      ['EMI ' + (i+1) + ' Misc',       s.misc  ? M(s.misc)  : '—'],
      ['EMI ' + (i+1) + ' Cashflow',   s.cashflow ? M(s.cashflow) : '—'],
    ])),
    ['AK Share of EMI',              M(l.akShareOfEmi)],
    ['AKS Share of EMI',             M(l.aksShareOfEmi)],
    ['Drive Link',                   l.driveLink ? '<a href="'+l.driveLink+'" target="_blank" style="color:#534AB7">Open ↗</a>' : '—'],
    ['Down Payment %',               D(l.downPaymentPct)],
  ];

  $('cd-detail-loanid').textContent = l.loanId;
  $('cd-detail-sub').textContent    = l.customerName + (l.phone ? ' · ' + l.phone : '') + (l.model ? ' · ' + l.model : '');
  $('cd-detail-kv').innerHTML = rows.map(([label, val]) =>
    `<span class="kv-l">${label}</span><span class="kv-v">${val}</span>`
  ).join('');

  const panel = $('cd-detail-panel');
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeCdDetail() {
  $('cd-detail-panel').style.display = 'none';
  document.querySelectorAll('#page-closed-defaulted .emi-card').forEach(c => c.classList.remove('selected'));
}

// ── Formatting helpers ────────────────────────────────────────────────────
function fmtAmt(n) { return (n == null || n === '') ? '—' : '₹' + Number(n).toLocaleString('en-IN'); }

// Parses sheet date strings robustly — handles "16-May-23", "2025-03-15", Date objects, etc.
function parseSheetDate(d) {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d) ? null : d;
  const s = String(d).trim();
  if (!s) return null;

  // Format: "16-May-23" or "16-May-2023"
  const m1 = s.match(/^(\d{1,2})[\-\/](\w{3})[\-\/](\d{2,4})$/);
  if (m1) {
    const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
    const mon = months[m1[2].toLowerCase()];
    if (mon !== undefined) {
      let yr = parseInt(m1[3]);
      if (yr < 100) yr += yr < 50 ? 2000 : 1900;
      return new Date(yr, mon, parseInt(m1[1]));
    }
  }
  // Format: "YYYY-MM-DD"
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return new Date(parseInt(m2[1]), parseInt(m2[2])-1, parseInt(m2[3]));

  // Format: "DD/MM/YYYY"
  const m3 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m3) return new Date(parseInt(m3[3]), parseInt(m3[2])-1, parseInt(m3[1]));

  const dt = new Date(s);
  return isNaN(dt) ? null : dt;
}

function fmtDisplayDate(d) {
  if (!d) return '—';
  const dt = parseSheetDate(d);
  if (!dt) return String(d);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
