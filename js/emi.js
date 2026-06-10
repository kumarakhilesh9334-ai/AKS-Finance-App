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
  if (S.page === 'my-subs')    renderMySubs();
}

// ── Page init ─────────────────────────────────────────────────────────────
function populateEmiSelect() {
  $('emi-search').value = '';
  $('emi-detail').style.display = 'none';
  S.selectedEmiLoanId = null;
  // Fire partials fetch in background
  fetchApprovedPartials();
  // Show loading state immediately; fetchLoansFromSheets will re-render when done
  if (!S.sheetLoans || !S.sheetLoans.length) {
    $('col-upcoming-list').innerHTML = '<div class="emi-col-empty" style="color:#534AB7">Loading loans…</div>';
    $('col-overdue-list').innerHTML  = '<div class="emi-col-empty" style="color:#534AB7">Loading loans…</div>';
    $('col-partials-list').innerHTML = '<div class="emi-col-empty" style="color:#534AB7">Loading…</div>';
    $('col-upcoming-count').textContent = '…';
    $('col-overdue-count').textContent  = '…';
    $('col-partials-count').textContent = '…';
  } else {
    renderEmiColumns('');
  }
}

// ── Three-column renderer ─────────────────────────────────────────────────
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

  // Partial payments column
  const partials = S.approvedPartials.filter(p => {
    if (!q) return true;
    return p.loanId.toLowerCase().includes(q) || (p.customerName||'').toLowerCase().includes(q);
  });

  $('col-upcoming-count').textContent = upcoming.length;
  $('col-overdue-count').textContent  = overdue.length;
  $('col-partials-count').textContent = partials.length;
  // Sync mobile tab badges
  ['upcoming','overdue','partials'].forEach(c => {
    const colEl = $('col-' + c + '-count');
    const mobEl = $('mob-' + c + '-count');
    if (colEl && mobEl) mobEl.textContent = colEl.textContent;
  });
  const noDataMsg = (!S.sheetLoans || !S.sheetLoans.length) ? '<div class="emi-col-empty">Fetching from Sheets…</div>' : '';
  $('col-upcoming-list').innerHTML = upcoming.length ? upcoming.map(l => emiCard(l, 'upcoming')).join('') : (noDataMsg || '<div class="emi-col-empty">No upcoming EMIs</div>');
  $('col-overdue-list').innerHTML  = overdue.length  ? overdue.map(l  => emiCard(l, 'overdue')).join('')  : (noDataMsg || '<div class="emi-col-empty">All clear ✓</div>');
  $('col-partials-list').innerHTML = partials.length ? partials.map(p => partialCard(p)).join('') : '<div class="emi-col-empty">No partial payments</div>';
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

function partialCard(p) {
  const dateStr = p.receivedDate ? fmtDisplayDate(p.receivedDate) : '—';
  return `<div class="emi-card" data-loanid="${p.loanId}" style="border-left:3px solid #A32D2D">
    <div class="emi-card-top">
      <span class="emi-card-id">${p.loanId}</span>
      <span class="badge b-pending" style="font-size:10px">Partial</span>
    </div>
    <div class="emi-card-name">${p.customerName}</div>
    <div class="emi-card-meta" style="margin-top:4px">
      <span class="emi-amt-pill" style="background:#FFF0E6;color:#A32D2D">${fmtAmt(p.amount)}</span>
      <span style="font-size:11px;color:#888">${dateStr}</span>
    </div>
    <button class="btn btn-sm btn-primary" onclick="event.stopPropagation();logRemainingPartial('${p.id}', ${p.amount})" style="margin-top:6px;width:100%;font-size:11px;padding:4px 0">Log remaining</button>
  </div>`;
}

// ── Loan selection ────────────────────────────────────────────────────────
// Event delegation for emi-card clicks in Log EMI tab only
document.addEventListener('click', function(e) {
  const card = e.target.closest('#page-emi .emi-card[data-loanid]');
  if (card) {
    const loanId = card.dataset.loanid;
    if (!card.classList.contains('no-action')) selectEmiLoan(loanId);
  }
});

async function selectEmiLoan(loanId) {
  showLoader();
  try {
    document.querySelectorAll('.emi-card').forEach(r => r.classList.remove('selected'));
    document.querySelectorAll(`.emi-card[data-loanid="${loanId}"]`).forEach(r => r.classList.add('selected'));
    S.selectedEmiLoanId = loanId;

    let loan = (S.sheetLoans && S.sheetLoans.find(l => l.loanId === loanId))
      || (() => { const l = S.loans.find(l => l.loanId === loanId); return l ? { ...l.data, status:'Active', slots:[], numReceivedEmi: l.emis.length } : null; })();
    if (!loan) return;

    $('emi-detail-loanid').textContent = loanId;
    $('emi-detail-sub').textContent    = loan.customerName || '';

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

  // EMI slots — tabular format
  const duration = loan.emiDuration || 0;
  const slots    = loan.slots || [];
  const today2 = new Date(); today2.setHours(0,0,0,0);
  const pendingEmiSet = new Set(
    S.pending.filter(p => p.type==='emi' && p.data.loanId===loanId && p.status==='pending')
      .map(p => Number(p.data.emiNum))
  );
  if (duration > 0) {
    let tableHtml = '<table class="emi-table"><thead><tr><th>EMI</th><th>Status</th><th>Due Date</th><th>Rcvd Date</th><th>Amount</th><th>Misc</th></tr></thead><tbody>';
    for (let i = 0; i < duration && i < 8; i++) {
      const slot = slots[i] || { num:i+1, received:false, scheduledDate:'', receivedDate:'', misc:0, cashflow:0 };
      const scheduledTxt = slot.scheduledDate ? fmtDisplayDate(slot.scheduledDate) : '—';
      const receivedTxt  = slot.receivedDate  ? fmtDisplayDate(slot.receivedDate)  : '—';
      let statusHtml, rowClass = '';
      if (slot.received) {
        statusHtml = '<span class="badge b-approved">Received</span>';
        rowClass = ' rcvd';
      } else {
        const isNext = i === loan.numReceivedEmi;
        const isOvd  = slot.scheduledDate && new Date(slot.scheduledDate) < today2;
        if (isNext) { statusHtml = '<span class="badge b-pending">Next due</span>'; rowClass = ' next'; }
        else if (isOvd) { statusHtml = '<span style="color:#A32D2D;font-weight:500">⚠ Overdue</span>'; rowClass = ' ovd'; }
        else { statusHtml = '<span style="color:#888">Pending</span>'; }
      }
      if (pendingEmiSet.has(i+1)) statusHtml += ' <span class="badge b-pending" style="font-size:10px">⏳ Pending</span>';
      const miscTxt = slot.misc !== 0 ? fmtAmt(slot.misc) : '—';
      tableHtml += `<tr class="emi-tr${rowClass}"><td>${i+1}</td><td>${statusHtml}</td><td>${scheduledTxt}</td><td>${receivedTxt}</td><td>${fmtAmt(slot.cashflow)}</td><td>${miscTxt}</td></tr>`;
    }
    tableHtml += '</tbody></table>';
    $('emi-slots').innerHTML = tableHtml;
    $('emi-slots-wrap').style.display = 'block';
  } else {
    $('emi-slots').innerHTML = '';
    $('emi-slots-wrap').style.display = 'none';
  }

  // Show approved partial payment banner if any exist for this loan
  const bannerEl = $('emi-partial-banner');
  if (bannerEl) {
    const partialItems = S.approvedPartials.filter(p => p.loanId === loanId);
    if (partialItems.length) {
      let h = '<div class="divider"></div><div style="font-size:12px;font-weight:500;color:#A32D2D;margin-bottom:6px">Approved Partial Payments</div>';
      partialItems.forEach(p => {
        const dateStr = p.receivedDate ? fmtDisplayDate(p.receivedDate) : '—';
        h += `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;margin:6px 0;background:#fff5f5;border-radius:8px;border:0.5px solid #e8c8c8">
          <div>
            <div style="font-size:13px;font-weight:500">EMI ${p.emiNum} · ${fmtAmt(p.amount)} received</div>
            <div style="font-size:11px;color:#888">Received on: ${dateStr}</div>
          </div>
        </div>`;
      });
      bannerEl.innerHTML = h;
    } else {
      bannerEl.innerHTML = '';
    }
  }

  const nextNum = loan.numReceivedEmi + 1;
  // Expected to collect = monthlyEmi - extraEmiReceived
  const extraReceived = loan.extraEmiReceived || 0;
  const expectedAmt   = Math.max(0, (loan.monthlyEmi || 0) - extraReceived);
  let labelTxt = nextNum > duration ? 'All EMIs collected!'
    : `Recording: EMI ${nextNum} of ${duration} · Standard EMI: ${fmtAmt(loan.monthlyEmi)}${extraReceived ? ' · Expected to collect: ' + fmtAmt(expectedAmt) : ''}`;
  $('emi-next-label').textContent = labelTxt;
  // Check scheduled EMI date vs today — confirm if >10 days away
  if (nextNum <= duration && loan.emiStartDate) {
    const parts = String(loan.emiStartDate).match(/(\d{1,2})[\-\/](\w{3})[\-\/](\d{2,4})/);
    if (parts) {
      const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
      const sd = new Date(parseInt(parts[3])<100?2000+parseInt(parts[3]):parseInt(parts[3]), months[parts[2].toLowerCase()], parseInt(parts[1]));
      sd.setMonth(sd.getMonth() + (nextNum - 1));
      const today = new Date(); today.setHours(0,0,0,0);
      const diff = Math.round((sd - today) / (1000*60*60*24));
      if (diff > 10) {
        if (!confirm('Scheduled date for EMI ' + nextNum + ' is ' + diff + ' days from now. Are you sure?')) {
          closeEmiDetail(); return;
        }
      }
    }
  }

  // Prefill with full monthly EMI (agent types what they actually received)
  $('emi-amt').value  = loan.monthlyEmi || '';
  // Default payment date = today
  $('emi-date').value = new Date().toISOString().split('T')[0];
  $('emi-notes').value  = '';
  $('emi-reason').value = '';
  $('emi-reason-wrap').style.display = 'none';
  $('emi-diff-warn').style.display   = 'none';

  // Disable submit button if this EMI already has a pending submission
  const subBtn = $('emi-submit-btn');
  if (pendingEmiSet.has(nextNum)) {
    subBtn.disabled = true;
    subBtn.style.opacity = '0.5';
    subBtn.style.cursor = 'not-allowed';
    $('emi-next-label').textContent = '⚠ EMI ' + nextNum + ' already pending approval.';
  } else {
    subBtn.disabled = false;
    subBtn.style.opacity = '';
    subBtn.style.cursor = '';
  }
  } finally { hideLoader(); }
}

// ── Diff check ────────────────────────────────────────────────────────────
function closeEmiDetail() {
  $('emi-detail').style.display = 'none';
  S.selectedEmiLoanId = null;
  document.querySelectorAll('.emi-card').forEach(r => r.classList.remove('selected'));
}

function checkEmiDiff() {
  const loanId = S.selectedEmiLoanId; if (!loanId) return;
  const loan = (S.sheetLoans && S.sheetLoans.find(l => l.loanId === loanId)) || S.loans.find(l => l.loanId === loanId);
  if (!loan) return;
  const stdEmi  = loan.monthlyEmi || loan?.data?.monthlyEmi || 0;
  const got     = parseFloat($('emi-amt').value) || 0;
  if (!got) return;
  const diff = got - stdEmi;
  if (Math.abs(diff) > 1) {
    $('emi-reason-wrap').style.display = 'block';
    $('emi-diff-warn').style.display   = 'block';
    $('emi-diff-msg').textContent = `Differs from standard EMI ${fmtAmt(stdEmi)} by ${diff>0?'+':''}${fmtAmt(Math.abs(diff))}. Please select a reason.`;
  } else {
    $('emi-reason-wrap').style.display = 'none';
    $('emi-diff-warn').style.display   = 'none';
  }
}

// ── Submit ────────────────────────────────────────────────────────────────
async function submitEmi() {
  const loanId = S.selectedEmiLoanId;
  if (!loanId) { showAlert('Please select a loan first.', 'e'); return; }
  const sheetLoan = S.sheetLoans && S.sheetLoans.find(l => l.loanId === loanId);
  const inAppLoan = S.loans.find(l => l.loanId === loanId);
  if (!sheetLoan && !inAppLoan) { showAlert('Loan data not found.', 'e'); return; }
  const amt  = parseFloat($('emi-amt').value) || 0;
  const date = v('emi-date');
  if (!amt || !date) { showAlert('Please enter amount and payment date.', 'e'); return; }
  const extraRcv = (sheetLoan ? sheetLoan.extraEmiReceived : 0) || 0;
  const stdEmi   = sheetLoan ? sheetLoan.monthlyEmi : inAppLoan.data.monthlyEmi;
  const expected = Math.max(0, stdEmi - extraRcv);
  if (Math.abs(amt - stdEmi) > 1 && !v('emi-reason')) { showAlert('Please select a reason for the amount difference.', 'e'); return; }
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
    amount:         amt, expectedAmount: stdEmi, misc: amt - stdEmi,
    date, scheduledDate, emiStartDate,
    received: receivedVal,
    mode: v('emi-mode'), reason: v('emi-reason'), notes: v('emi-notes'),
    akShare:  sheetLoan ? Math.round(sheetLoan.akShare  * 100) : inAppLoan.data.akShare,
    aksShare: sheetLoan ? Math.round(sheetLoan.aksShare * 100) : inAppLoan.data.aksShare,
  };
  const emiItem = { id: nextPid(), type: 'emi', data: d, submittedBy: S.cu.id, submittedAt: new Date().toISOString(), status: 'pending', note: '' };
  showAlert('Submitting…', 'w');
  showLoader();
  try {
    if (S.sheetsUrl) {
      const res = await gasPost({action:'saveEmi', item:emiItem});
      if (res.ok && res.pending) S.pending = res.pending;
      else await fetchPendingFromSheets();
    }
    refreshNav();
    renderApprovals($('appr-search') ? $('appr-search').value : '');
    showAlert('EMI payment submitted for approval.');
  } finally { hideLoader(); }
  $('emi-detail').style.display = 'none';
  S.selectedEmiLoanId = null;
  document.querySelectorAll('.emi-card').forEach(r => r.classList.remove('selected'));
  if ($('emi-received')) $('emi-received').value = 'true';
}

// ── Fetch approved partial payments ──────────────────────────────────────
async function fetchApprovedPartials() {
  if (!S.sheetsUrl) return;
  try {
    const res  = await fetch(S.sheetsUrl + '?action=readApprovedPartials');
    const data = await res.json();
    if (data.ok && Array.isArray(data.partials)) {
      S.approvedPartials = data.partials;
      rerenderActiveTab();
    }
  } catch(e) { console.warn('fetchApprovedPartials error:', e.message); }
}

// ── Log remaining payment for an approved partial ─────────────────────────
async function logRemainingPartial(id, currentAmount) {
  const additional = prompt('Enter remaining amount (₹):');
  if (!additional) return;
  const newDate = prompt('Enter new receiving date (YYYY-MM-DD):', new Date().toISOString().split('T')[0]);
  if (!newDate) return;
  showAlert('Updating…', 'w');
  showLoader();
  try {
    const res = await gasPost({action:'updateRemainingEmi', id, additionalAmount: parseFloat(additional), newDate});
    if (res.ok && res.pending) S.pending = res.pending;
    else await fetchPendingFromSheets();
    await fetchApprovedPartials();
    refreshNav();
    rerenderActiveTab();
    renderApprovals($('appr-search') ? $('appr-search').value : '');
    showAlert('Remaining payment submitted for approval.');
  } finally { hideLoader(); }
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
  const today = new Date(); today.setHours(0,0,0,0);
  let bg = '', border = '', tc = '#1a1a1a', sc = '#888', flag = '', bottomTxt = '';

  if (type === 'running' && l.nextEmiDate) {
    const due = new Date(l.nextEmiDate); due.setHours(0,0,0,0);
    const days = Math.round((today - due) / 86400000);
    const df = fmtDisplayDate(l.nextEmiDate);
    bottomTxt = 'Due Date: ' + df;
    if (days > 90)        { bg='#000';border='#000';tc='#fff';sc='rgba(255,255,255,0.75)';flag='90+ days overdue'; }
    else if (days > 30)   { bg='#980000';border='#980000';tc='#fff';sc='rgba(255,255,255,0.75)';flag='30+ days overdue'; }
    else if (days > 0)    { bg='#dd7e6b';border='#dd7e6b';tc='#fff';sc='rgba(255,255,255,0.75)';flag=days+'d overdue'; }
    else if (due.getTime()===today.getTime()) { bg='#ff9900';border='#ff9900';tc='#fff';sc='rgba(255,255,255,0.75)';flag='Due today'; }
  }

  const cs = bg ? `background:${bg} !important;border-left-color:${border} !important;border-color:${border} !important` : '';
  const ps = bg ? 'background:rgba(255,255,255,0.2);color:#fff' : '';

  return `<div class="emi-card ${type}" data-loanid="${l.loanId}" data-type="${type}" onclick="openCdDetail('${l.loanId}')" style="cursor:pointer;${cs}">
    <div class="emi-card-top">
      <span class="emi-card-id" style="color:${tc}">${l.loanId}</span>
      <span class="badge ${type==='running'?'b-active':type==='closed'?'b-closed':'b-defaulted'}">${type}</span>
    </div>
    <div class="emi-card-name" style="color:${tc}">${l.customerName}</div>
    <div class="emi-card-meta">
      <span class="emi-amt-pill" style="${ps}">${fmtAmt(l.monthlyEmi)}/mo</span>
      ${l.model?`<span class="emi-model-pill" style="${ps}">${l.model}</span>`:''}
    </div>
    <div class="emi-card-date" style="color:${sc}${flag?';display:flex;justify-content:space-between':''}">
      <span>${type==='running' ? bottomTxt : type==='closed' ? 'Last EMI: '+lastDate : (l.defaultComment||'Defaulted')}</span>
      ${flag?`<span style="font-size:9px;font-weight:600;color:rgba(255,255,255,0.85)">${flag}</span>`:''}
    </div>
  </div>`;
}

function cdFmt(n) { return (n==null||n===''||n===0) ? '—' : '₹'+Number(n).toLocaleString('en-IN'); }

async function openCdDetail(loanId) {
  showLoader();
  try {
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
  const D = (v) => (v === 'Invalid Date') ? '—' : (v || '—');
  const M = (v) => (v == null || v === '') ? '—' : '₹' + Number(v).toLocaleString('en-IN');
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
    ['AK Share of EMI',              M(l.akShareOfEmi)],
    ['AKS Share of EMI',             M(l.aksShareOfEmi)],
    ['Drive Link',                   l.driveLink ? '<a href="'+l.driveLink+'" target="_blank" style="color:#534AB7">Open ↗</a>' : '—'],
    ['Down Payment %',               D(l.downPaymentPct)],
  ];

  // Build EMI slots table separately
  let emiTableHtml = '';
  const slots2 = l.slots || [];
  if (slots2.length) {
    emiTableHtml = '<div style="margin-top:0.75rem"><div style="font-size:12px;font-weight:600;color:#534AB7;margin-bottom:6px">EMI Schedule</div><table class="emi-table"><thead><tr><th>EMI</th><th>Received</th><th>Due Date</th><th>Rcvd Date</th><th>Misc</th><th>Cashflow</th></tr></thead><tbody>';
    slots2.forEach((s,i) => {
      emiTableHtml += `<tr class="emi-tr${s.received?' rcvd':''}"><td>${i+1}</td><td>${Bool(s.received)}</td><td>${s.scheduledDate?fmtDisplayDate(s.scheduledDate):'—'}</td><td>${s.receivedDate?fmtDisplayDate(s.receivedDate):'—'}</td><td>${s.misc?M(s.misc):'—'}</td><td>${s.cashflow?M(s.cashflow):'—'}</td></tr>`;
    });
    emiTableHtml += '</tbody></table></div>';
  }

  const HIDDEN_LABELS = new Set([
    'Rate of Interest', 'App Lock Charge', 'AK Share', 'AKS Share',
    'AK Amount', 'AK Paid to Kunal', 'AKS Amount', 'AKS Paid to Kunal',
    'Remaining Principal', 'Remaining Interest', 'Received Principal', 'Received Interest',
    'Late Payment Fine', 'Early Loan Closing Settlement', 'Extra EMI Received',
    'Recovery Charge', 'Welcome Message Sent', 'Loan Closing Message Sent',
    'Default Comment', 'Final ROI', 'AK Share of EMI', 'AKS Share of EMI',
    'Drive Link', 'Down Payment %',
  ]);

  $('cd-detail-loanid').textContent = l.loanId;
  $('cd-detail-sub').textContent    = l.customerName + (l.phone ? ' · ' + l.phone : '') + (l.model ? ' · ' + l.model : '');
  $('cd-detail-kv').innerHTML = rows
    .filter(([label]) => !HIDDEN_LABELS.has(label))
    .map(([label, val]) => `<span class="kv-l">${label}</span><span class="kv-v">${val}</span>`
  ).join('') + emiTableHtml;

  const panel = $('cd-detail-panel');
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } finally { hideLoader(); }
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


