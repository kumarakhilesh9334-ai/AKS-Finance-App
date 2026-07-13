// ── EMI ───────────────────────────────────────────────────────────────────
// Log EMI tab: two-column layout — Upcoming (left) | Overdue (right)
// Closed & Defaulted are on their own admin-only tab.

const _debounceTimers = {};
function debounced(fn, key, ms) {
  clearTimeout(_debounceTimers[key]);
  _debounceTimers[key] = setTimeout(fn, ms);
}
function onSearchInput(v) {
  debounced(() => renderAllOverview(v), 'ov-search', 250);
}
function clearOverviewSearch() {
  const inp = $('ov-search');
  if (inp) { inp.value = ''; renderAllOverview(''); inp.focus(); }
}

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
    // Step 1: Slim fetch — card columns only, instant render
    const slimRes  = await gasGet('readLoansSlim');
    if (!slimRes.ok) throw new Error(slimRes.error || 'Unknown error');
    S.sheetLoans   = slimRes.loans || [];
    S._fullLoaded  = false;
    cacheState();   // persist slim data immediately
    rerenderActiveTab();

    // Step 2: Pre-fetch full data (93 cols + miscType) + revised dates in parallel
    const [fullData, revData] = await Promise.all([
      gasGet('readAllLoans'),
      gasGet('readRevisedDates'),
    ]);
    if (fullData.ok) { S.sheetLoans = fullData.loans || []; S._fullLoaded = true; }
    if (revData.ok) S.revisedDates = revData.dates;
    cacheState();   // persist fresh data to localStorage

    // Re-render cards with full data + revised badges now available
    rerenderActiveTab();

    if (statusEl) {
      statusEl.textContent = '✓ ' + S.sheetLoans.length + ' loans loaded.';
      statusEl.className = 'emi-fetch-status ok';
      setTimeout(() => { if ($('emi-fetch-status')) $('emi-fetch-status').textContent = ''; }, 3000);
    }
  } catch (err) {
    if (statusEl) { statusEl.textContent = '⚠ Could not load: ' + err.message; statusEl.className = 'emi-fetch-status warn'; }
    S.sheetLoans = [];
  }
}

function rerenderActiveTab() {
  if (S.page === 'all-loans') renderAllOverview($('ov-search') ? $('ov-search').value : '');
  if (S.page === 'my-subs')      renderMySubs();
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
  // Show/hide revised view
  if (S.showRevisedView) {
    const tc = document.querySelector('.emi-two-col');
    if (tc) tc.style.display = 'none';
    const mt = document.querySelector('.mob-col-tabs');
    if (mt) mt.style.display = 'none';
    const rv = $('emi-revised-view');
    if (rv) rv.style.display = 'block';
    renderRevisedView();
    return;
  } else {
    const tc = document.querySelector('.emi-two-col');
    if (tc) tc.style.display = '';
    const mt = document.querySelector('.mob-col-tabs');
    if (mt) mt.style.display = '';
    const rv = $('emi-revised-view');
    if (rv) rv.style.display = 'none';
  }
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
    ? active.filter(l => l.loanId.toLowerCase().includes(q) || l.customerName.toLowerCase().includes(q) || (l.phone||'').includes(q) || (l.guarantor||'').toLowerCase().includes(q) || (l.model||'').toLowerCase().includes(q) || (l.aadhaarPan||'').toLowerCase().includes(q))
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

  $('col-all-count').textContent    = upcoming.length + overdue.length + partials.length;
  $('col-upcoming-count').textContent = upcoming.length;
  $('col-overdue-count').textContent  = overdue.length;
  $('col-partials-count').textContent = partials.length;
  // Sync mobile tab badges
  ['all','upcoming','overdue','partials'].forEach(c => {
    const colEl = $('col-' + c + '-count');
    const mobEl = $('mob-' + c + '-count');
    if (colEl && mobEl) mobEl.textContent = colEl.textContent;
  });
  const noDataMsg = (!S.sheetLoans || !S.sheetLoans.length) ? '<div class="emi-col-empty">Fetching from Sheets…</div>' : '';
  $('col-all-list').innerHTML      = (upcoming.length + overdue.length + partials.length)
    ? [...upcoming.map(l => emiCard(l, 'upcoming')), ...overdue.map(l => emiCard(l, 'overdue')), ...partials.map(p => partialCard(p))].join('')
    : (noDataMsg || '<div class="emi-col-empty">No active loans</div>');
  $('col-upcoming-list').innerHTML = upcoming.length ? upcoming.map(l => emiCard(l, 'upcoming')).join('') : (noDataMsg || '<div class="emi-col-empty">No upcoming EMIs</div>');
  $('col-overdue-list').innerHTML  = overdue.length  ? overdue.map(l  => emiCard(l, 'overdue')).join('')  : (noDataMsg || '<div class="emi-col-empty">All clear ✓</div>');
  $('col-partials-list').innerHTML = partials.length ? partials.map(p => partialCard(p)).join('') : '<div class="emi-col-empty">No partial payments</div>';
}

// ── Revised badge helper (used by both emiCard and cdCard) ──────────────
function revisedBadgeHtml(loan) {
  const loanId = loan.loanId;
  const nextEmiNum = (loan.numReceivedEmi || 0) + 1;
  const revDates = S.revisedDates.filter(rd => rd.loanId === loanId && rd.emiNum === nextEmiNum);
  if (!revDates.length) return '';
  const jabtRecord = revDates.find(rd => rd.note === 'Mobile Jabt');
  // Find unreceived revised EMIs (skip those already paid)
  const unpaidRevisions = revDates.filter(rd => {
    if (rd.note === 'Mobile Jabt') return false;
    const slot = (loan.slots || []).find(s => s.num === rd.emiNum);
    return !slot || !slot.received;
  });
  // Mobile Jabt takes priority over unpaid revisions
  if (jabtRecord) {
    return `<div style="text-align:center;margin-bottom:2px"><span style="display:inline-block;font-size:12px;font-weight:600;color:#000;background:#fff;padding:1px 10px;border-radius:8px;border:1px solid #ddd">Mobile Jabt</span></div>`;
  }
  if (!unpaidRevisions.length) return '';
  const latest = unpaidRevisions.reduce((a, b) => {
    const da = parseSheetDate(a.revisedDate);
    const db = parseSheetDate(b.revisedDate);
    if (!da) return b; if (!db) return a;
    return da > db ? a : b;
  });
  const revDateStr = latest.revisedDate ? fmtDisplayDate(latest.revisedDate) : '';
  const revDt = parseSheetDate(latest.revisedDate);
  let prefix = '';
  if (revDt) {
    const t = new Date(); t.setHours(0,0,0,0);
    const diff = Math.round((revDt - t) / 86400000);
    if (diff === 0) prefix = '⚠️ ';
    else if (diff < 0) prefix = '❌ ';
  }
  const text = `${prefix}Revised: ${revDateStr}`;
  return `<div style="text-align:center;margin-bottom:2px"><span style="display:inline-block;font-size:12px;font-weight:600;color:#000;background:#fff;padding:1px 10px;border-radius:8px;border:1px solid #ddd">${text}</span></div>`;
}

function emiCard(l, type) {
  const dueTxt  = l.nextEmiDate ? 'Due: ' + fmtDisplayDate(l.nextEmiDate) : '—';
  const lateTxt = l.lateEmis ? l.lateEmis + '/' + l.numReceivedEmi + ' late' : '';
  const billTxt = l.billDate ? fmtDisplayDate(l.billDate) : '';

  const today = new Date(); today.setHours(0,0,0,0);
  let bg = '', border = '', textColor = '#1a1a1a', subColor = '#888', overdueLabel = '';

  // Check if this loan has a pending EMI submission (server + local)
  const hasPendingEmi = (S.pending && S.pending.some(p => p.type==='emi' && p.data.loanId===l.loanId && p.status==='pending'))
    || Object.keys(S._submittedEmis || {}).some(k => k.startsWith(l.loanId + '_'));

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
    ${revisedBadgeHtml(l)}
    <div class="emi-card-top">
      <span class="emi-card-id" style="color:${textColor}">${l.loanId}</span>
      <div style="text-align:right">
        <div class="emi-card-date-big" style="color:${textColor}">${dueTxt}</div>
      </div>
    </div>
    <div class="emi-card-name" style="display:flex;justify-content:space-between;align-items:center;color:${textColor};gap:8px">
      <span>${l.customerName}</span>
      ${overdueLabel ? `<span style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.85);flex-shrink:0">${overdueLabel}</span>` : ''}
    </div>
    <div class="emi-card-meta">
      <span class="emi-amt-pill" style="${pillStyle}">${billTxt ? 'Bill: '+billTxt : '—'}</span>
      <span class="emi-amt-pill" style="${pillStyle}">${fmtAmt(l.monthlyEmi)}/mo</span>
      ${l.model ? `<span class="emi-model-pill" style="${pillStyle}">${l.model}</span>` : ''}
      ${lateTxt ? `<span class="emi-late-pill" style="${pillStyle}">&#9888; ${lateTxt}</span>` : ''}
      ${hasPendingEmi ? `<span class="emi-late-pill" style="${pillStyle}">⏳ Pending</span>` : ''}
      ${partialIndicator(l, subColor)}
    </div>
  </div>`;
}

function partialIndicator(l, subColor) {
  const pts = S.approvedPartials || [];
  const items = pts.filter(p => p.loanId === l.loanId);
  if (!items.length) return '';
  const total = items.reduce((s, p) => s + Number(p.amount || 0), 0);
  return `<span style="font-size:12px;font-weight:700;color:${subColor||'#888'};margin-left:auto;flex-shrink:0">${fmtAmt(total)} already received</span>`;
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

// ── Revised Overdue toggle ───────────────────────────────────────────────
// ── Revised View toggle ──────────────────────────────────────────────────
const _revViewCollapsed = { upcoming: false, overdue: false };

function toggleRevisedView() {
  S.showRevisedView = !S.showRevisedView;
  const btn = $('revised-view-toggle');
  if (btn) {
    if (S.showRevisedView) {
      btn.style.background = '#399C9C';
      btn.style.color = '#fff';
    } else {
      btn.style.background = 'none';
      btn.style.color = '#399C9C';
    }
  }
  renderEmiColumns($('emi-search') ? $('emi-search').value : '');
}

window.__revViewToggle = function(label) {
  _revViewCollapsed[label] = !_revViewCollapsed[label];
  renderRevisedView();
};

function renderRevisedView() {
  const el = $('emi-revised-view');
  if (!el) return;
  const q = (($('emi-search') ? $('emi-search').value : '') || '').toLowerCase();
  const source = (S.sheetLoans && S.sheetLoans.length) ? S.sheetLoans : [];
  const active = source.filter(l => !l.isDefaulted && !l.emiCompleted && l.status !== 'Closed');
  const filtered = q ? active.filter(l => l.loanId.toLowerCase().includes(q) || (l.customerName||'').toLowerCase().includes(q)) : active;

  // Only loans with unpaid revised dates
  const today = new Date(); today.setHours(0,0,0,0);
  const hasRevDates = filtered.filter(l => {
    const revs = S.revisedDates.filter(rd => rd.loanId === l.loanId);
    // At least one unpaid revision OR a Mobile Jabt record
    return revs.some(rd => {
      if (rd.note === 'Mobile Jabt') return true;
      const slot = (l.slots || []).find(s => s.num === rd.emiNum);
      return !slot || !slot.received;
    });
  });

  const upcoming = [], overdue = [], mobileJabt = [];
  hasRevDates.forEach(l => {
    const hasJabt = S.revisedDates.some(rd => rd.loanId === l.loanId && rd.note === 'Mobile Jabt');
    if (hasJabt) { mobileJabt.push(l); return; }
    const dates = S.revisedDates.filter(rd => rd.loanId === l.loanId && rd.revisedDate);
    let latest = null;
    dates.forEach(d => { const dt = parseSheetDate(d.revisedDate); if (dt && (!latest || dt > latest)) latest = dt; });
    if (!latest) { upcoming.push(l); return; }
    if (latest >= today) upcoming.push(l); else overdue.push(l);
  });
  // Sort: overdue descending (most overdue first), scheduled ascending (soonest first)
  const getLastRev = (lid) => { let m = null; S.revisedDates.filter(rd => rd.loanId === lid && rd.revisedDate).forEach(d => { const dt = parseSheetDate(d.revisedDate); if (dt && (!m || dt > m)) m = dt; }); return m; };
  const getFirstRev = (lid) => { let m = null; S.revisedDates.filter(rd => rd.loanId === lid && rd.revisedDate).forEach(d => { const dt = parseSheetDate(d.revisedDate); if (dt && (!m || dt < m)) m = dt; }); return m; };
  overdue.sort((a, b) => { const da = getLastRev(a.loanId), db = getLastRev(b.loanId); if (!da && !db) return 0; if (!da) return 1; if (!db) return -1; return db - da; });
  upcoming.sort((a, b) => { const da = getFirstRev(a.loanId), db = getFirstRev(b.loanId); if (!da && !db) return 0; if (!da) return 1; if (!db) return -1; return da - db; });

  function sectionHtml(label, key, color, bg, icon, items, cardType) {
    const collapsed = _revViewCollapsed[key];
    return `<div class="card" style="margin-bottom:0.5rem;padding:0;overflow:hidden">
      <div onclick="window.__revViewToggle('${key}')" style="display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;background:${bg};user-select:none">
        <span style="font-size:14px">${collapsed ? '\u25B6' : '\u25BC'}</span>
        <span style="font-size:12px;font-weight:600;color:${color}">${icon} ${label}</span>
        <span style="font-size:11px;color:#888;margin-left:auto">${items.length}</span>
      </div>
      ${collapsed ? '' : `<div style="padding:6px">${items.map(l => emiCard(l, cardType)).join('')}</div>`}
    </div>`;
  }

  el.innerHTML = `<div style="font-size:12px;color:#888;margin-bottom:0.5rem">${hasRevDates.length} loan(s) with revised dates</div>`
    + sectionHtml('Revised (Overdue)', 'overdue', '#c62828', '#ffebee', '\uD83D\uDD34', overdue, 'overdue')
    + sectionHtml('Revised (Scheduled)', 'scheduled', '#2e7d32', '#e8f5e9', '\uD83D\uDFE2', upcoming, 'upcoming')
    + (mobileJabt.length ? sectionHtml('Mobile Jabt', 'mobile-jabt', '#000', '#f5f5f5', '\uD83D\uDCF1', mobileJabt, 'overdue') : '');
}

// ── Loan selection ────────────────────────────────────────────────────────
async function selectEmiLoan(loanId) {
  showLoader();
  try {
    document.querySelectorAll('.emi-card').forEach(r => r.classList.remove('selected'));
    document.querySelectorAll(`.emi-card[data-loanid="${loanId}"]`).forEach(r => r.classList.add('selected'));
    S.selectedEmiLoanId = loanId;

    let loan = (S.sheetLoans && S.sheetLoans.find(l => l.loanId === loanId))
      || (() => { const l = S.loans.find(l => l.loanId === loanId); return l ? { ...l.data, status:'Active', slots:[], numReceivedEmi: l.emis.length } : null; })();
    if (!loan) return;

    // If full data not yet loaded and card is slim, fetch detail on click
    if (!S._fullLoaded && loan._slim) {
      try {
        const data = await gasGet('readLoanDetail', { loanId });
        if (data.ok && data.loan) {
          const idx = S.sheetLoans.findIndex(l => l.loanId === loanId);
          if (idx !== -1) S.sheetLoans[idx] = data.loan;
          loan = data.loan;
        }
      } catch(e) { console.warn('Could not load detail:', e.message); }
    }

    $('emi-detail-loanid').textContent = loanId;
    $('emi-detail-sub').textContent    = loan.customerName || '';

    const detail = $('emi-detail');
    detail.style.display = 'block';
    if ($('emi-detail-ph')) $('emi-detail-ph').style.display = 'none';
    if (window.matchMedia('(orientation: portrait)').matches)
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
  // Merge locally-submitted EMIs (instant, no server dependency)
  Object.keys(S._submittedEmis || {}).forEach(k => {
    if (k.startsWith(loanId + '_')) pendingEmiSet.add(parseInt(k.split('_')[1]));
  });
  // Remove approved ones from local tracking
  [...pendingEmiSet].forEach(n => {
    if (loan.slots && loan.slots[n-1] && loan.slots[n-1].received) {
      delete S._submittedEmis[loanId + '_' + n];
      pendingEmiSet.delete(n);
    }
  });
  if (duration > 0) {
    let tableHtml = '<table class="emi-table"><thead><tr><th>EMI</th><th>Status</th><th>Due Date</th><th>Rcvd Date</th><th>Amount</th><th>Misc</th><th>Reason</th></tr></thead><tbody>';
    for (let i = 0; i < duration && i < 8; i++) {
      const slot = slots[i] || { num:i+1, received:false, scheduledDate:'', receivedDate:'', misc:0, cashflow:0 };
      const scheduledTxt = slot.scheduledDate ? fmtDisplayDate(slot.scheduledDate) : '—';
      const lateEmi = wasLateEmi(slot);
      const receivedTxt  = slot.receivedDate  ? fmtDisplayDate(slot.receivedDate) + (lateEmi ? ' <span style="color:#BA7517;font-size:11px" title="Received late">⚠️ late</span>' : '') : '—';
      let statusHtml, rowClass = '';
      if (slot.received) {
        statusHtml = '<span class="badge b-approved">Received</span>';
        rowClass = ' rcvd' + (lateEmi ? ' late' : '');
      }
      if (pendingEmiSet.has(i+1)) statusHtml += ' <span class="badge b-pending" style="font-size:10px">⏳ Pending</span>';
      const miscTxt = slot.misc !== 0 ? fmtAmt(slot.misc) : '—';
      const reason = slot.miscType || (pendingEmiSet.has(i+1) ? (S.pending.find(p => p.type==='emi' && p.data.loanId===loanId && p.status==='pending' && Number(p.data.emiNum)===i+1)?.data?.reason || '—') : '—');
      tableHtml += `<tr class="emi-tr${rowClass}"><td>${i+1}</td><td>${statusHtml}</td><td>${scheduledTxt}</td><td>${receivedTxt}</td><td>${fmtAmt(slot.cashflow)}</td><td>${miscTxt}</td><td style="font-size:11px;color:#555">${reason}</td></tr>`;
    }
    tableHtml += '</tbody></table>';
    $('emi-slots').innerHTML = tableHtml;
    $('emi-slots-wrap').style.display = 'block';
    // Show late payment fine & extra EMI received
    const fineEl = $('emi-fine-extra');
    if (fineEl) {
      const fine = loan.latePaymentFine || 0;
      const extra = loan.extraEmiReceived || 0;
      fineEl.innerHTML = (fine || extra) ? `<div style="display:flex;gap:16px;flex-wrap:wrap">
        ${fine ? `<span style="color:#A32D2D;font-weight:500">Late fine: ${fmtAmt(fine)}</span>` : ''}
        ${extra ? `<span style="color:#0F6E56;font-weight:500">Extra EMI: ${fmtAmt(extra)}</span>` : ''}
      </div>` : '';
    }
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

  // Revised date stats
  const statsEl = $('emi-revised-stats');
  const btnWrap = $('emi-revised-btn-wrap');
  if (statsEl) {
    const customerPrefix = loan.loanId.split('/')[0];
    const dates = S.revisedDates || [];
    const emiCount = dates.filter(d => d.loanId === loanId && d.emiNum === loan.numReceivedEmi + 1).length;
    const loanCount = dates.filter(d => d.loanId === loanId).length;
    const customerCount = dates.filter(d => d.loanId.split('/')[0] === customerPrefix).length;
    if (loanCount > 0) {
      statsEl.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap;padding:6px 0">
        <span style="color:#399C9C;font-weight:500">Revised Date Revisions:</span>
        <span>This EMI: <strong>${emiCount}</strong></span>
        <span>This Loan: <strong>${loanCount}</strong></span>
        <span>This Customer: <strong>${customerCount}</strong></span>
      </div>`;
    } else {
      statsEl.innerHTML = '';
    }
  }
  if (btnWrap) {
    btnWrap.style.display = (loan.numReceivedEmi < duration) ? '' : 'none';
    // Store the loan data for the form
    btnWrap.dataset.monthlyEmi = loan.monthlyEmi || '';
    btnWrap.dataset.duration = duration;
  }

  const nextNum = loan.numReceivedEmi + 1;
  // Expected to collect = monthlyEmi - extraEmiReceived
  const extraReceived = loan.extraEmiReceived || 0;
  const expectedAmt   = Math.max(0, (loan.monthlyEmi || 0) - extraReceived);
  let labelTxt = nextNum > duration ? 'All EMIs collected!'
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

  // Show revised date field for next EMI if this loan has a revised date for the current EMI
  const revWrap = $('emi-revised-next-wrap');
  const revDt   = $('emi-next-revised-date');
  if (revWrap && revDt) {
    const hasRevForCurrEmi = (S.revisedDates||[]).some(d => d.loanId === loanId && d.emiNum === nextNum);
    if (hasRevForCurrEmi && nextNum < duration) {
      revWrap.style.display = 'block';
      // Default = latest revised date + 1 month
      const loanRevs = (S.revisedDates||[]).filter(d => d.loanId === loanId && d.revisedDate);
      let latest = null;
      loanRevs.forEach(d => { const dt = parseSheetDate(d.revisedDate); if (dt && (!latest || dt > latest)) latest = dt; });
      if (latest) {
        const next = new Date(latest);
        next.setMonth(next.getMonth() + 1);
        revDt.value = next.getFullYear() + '-' + String(next.getMonth()+1).padStart(2,'0') + '-' + String(next.getDate()).padStart(2,'0');
      } else {
        revDt.value = '';
      }
    } else {
      revWrap.style.display = 'none';
      revDt.value = '';
    }
  }
  } finally { hideLoader(); }
}

function clearRevisedDateField() {
  const dt = $('emi-next-revised-date');
  if (dt) dt.value = '';
}

// ── Diff check ────────────────────────────────────────────────────────────
function closeEmiDetail() {
  $('emi-detail').style.display = 'none';
  if ($('emi-detail-ph')) $('emi-detail-ph').style.display = '';
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
      if (res.ok) {
        S._submittedEmis[loanId + '_' + emiNum] = true;
        if (res.pending) S.pending = res.pending;
        // Submit revised date for next EMI directly (no approval)
        const revDt = $('emi-next-revised-date');
        if (revDt && revDt.value && emiNum < (sheetLoan ? sheetLoan.emiDuration : 0)) {
          const nextNum2 = emiNum + 1;
          const nextAmt = sheetLoan ? sheetLoan.monthlyEmi : 0;
          const revRes = await gasPost({ action: 'setRevisedDate', loanId, emiNum: nextNum2, revisedDate: revDt.value, amount: nextAmt || 0, note: '' });
          if (revRes.ok) {
            try { const rd2 = await gasGet('readRevisedDates'); if (rd2.ok) S.revisedDates = rd2.dates; } catch(e) {}
          }
        }
        refreshNav();
        rerenderActiveTab();
        showAlert('EMI payment submitted for approval.');
      } else {
        await fetchPendingFromSheets();
        showAlert('Submission failed: ' + (res.error || 'Unknown error'), 'e');
      }
    }
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
    const data = await gasGet('readApprovedPartials');
    if (data.ok && Array.isArray(data.partials)) {
      S.approvedPartials = data.partials;
      cacheState();
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
    if (res.ok) {
      if (res.pending) S.pending = res.pending;
      await fetchApprovedPartials();
      refreshNav();
      rerenderActiveTab();
      renderApprovals($('appr-search') ? $('appr-search').value : '');
      showAlert('Remaining payment submitted for approval.');
    } else {
      await fetchPendingFromSheets();
      showAlert('Submission failed: ' + (res.error || 'Unknown error'), 'e');
    }
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

  const match = l => !q || l.loanId.toLowerCase().includes(q) || (l.customerName||'').toLowerCase().includes(q) || (l.phone||'').includes(q) || (l.guarantor||'').toLowerCase().includes(q) || (l.model||'').toLowerCase().includes(q) || (l.aadhaarPan||'').toLowerCase().includes(q);
  const fRunning   = running.filter(match);
  const fClosed    = closed.filter(match);
  const fDefaulted = defaulted.filter(match);

  $('cd-all-count').textContent      = fRunning.length + fClosed.length + fDefaulted.length;
  $('cd-running-count').textContent   = fRunning.length;
  $('cd-closed-count').textContent    = fClosed.length;
  $('cd-defaulted-count').textContent = fDefaulted.length;

  const loading = '<div class="emi-col-empty" style="color:#534AB7">Loading…</div>';
  const cdNoData = (!S.sheetLoans || !S.sheetLoans.length);
  const allCards = [...fRunning.map(l => cdCard(l, 'running')), ...fClosed.map(l => cdCard(l, 'closed')), ...fDefaulted.map(l => cdCard(l, 'defaulted'))];
  $('cd-all-list').innerHTML       = allCards.length ? allCards.join('') : (cdNoData ? loading : '<div class="emi-col-empty">No loans</div>');
  $('cd-running-list').innerHTML   = fRunning.length   ? fRunning.map(l   => cdCard(l, 'running')).join('')   : (cdNoData ? loading : '<div class="emi-col-empty">No running loans</div>');
  $('cd-closed-list').innerHTML    = fClosed.length    ? fClosed.map(l    => cdCard(l, 'closed')).join('')    : (cdNoData ? loading : '<div class="emi-col-empty">No closed loans</div>');
  $('cd-defaulted-list').innerHTML = fDefaulted.length ? fDefaulted.map(l => cdCard(l, 'defaulted')).join('') : (cdNoData ? loading : '<div class="emi-col-empty">No defaulted loans</div>');
}

function cdCard(l, type) {
  const today = new Date(); today.setHours(0,0,0,0);
  const billTxt = l.billDate ? fmtDisplayDate(l.billDate) : '';
  const lateTxt = l.lateEmis ? l.lateEmis + '/' + l.numReceivedEmi + ' late' : '';
  let bg = '', border = '', tc = '#1a1a1a', sc = '#888', overdueLabel = '';
  let rightDate = '';
  const hasPendingEmi = (S.pending && S.pending.some(p => p.type==='emi' && p.data.loanId===l.loanId && p.status==='pending'))
    || Object.keys(S._submittedEmis || {}).some(k => k.startsWith(l.loanId + '_'));

  if (type === 'running') {
    if (l.nextEmiDate) {
      const due = new Date(l.nextEmiDate); due.setHours(0,0,0,0);
      const days = Math.round((today - due) / 86400000);
      rightDate = 'Due: ' + fmtDisplayDate(l.nextEmiDate);
      if (days > 90)        { bg='#000';border='#000';tc='#fff';sc='rgba(255,255,255,0.75)';overdueLabel='90+ days overdue'; }
      else if (days > 30)   { bg='#980000';border='#980000';tc='#fff';sc='rgba(255,255,255,0.75)';overdueLabel='30+ days overdue'; }
      else if (days > 0)    { bg='#dd7e6b';border='#dd7e6b';tc='#fff';sc='rgba(255,255,255,0.75)';overdueLabel=days+'d overdue'; }
      else if (due.getTime()===today.getTime()) { bg='#ff9900';border='#ff9900';tc='#fff';sc='rgba(255,255,255,0.75)';overdueLabel='Due today'; }
    } else {
      rightDate = '—';
    }
  } else if (type === 'closed') {
    rightDate = '✓ Closed';
    tc = '#27500A';
  } else {
    rightDate = '⚠️ Defaulted';
    tc = '#A32D2D';
  }

  const cardStyle = bg ? `background:${bg};border-left-color:${border};border-color:${border}` : '';
  const pillStyle = bg ? 'background:rgba(255,255,255,0.2);color:#fff' : '';

  return `<div class="emi-card ${type}" data-loanid="${l.loanId}" data-type="${type}" onclick="openCdDetail('${l.loanId}')" style="cursor:pointer;${cardStyle}">
    ${revisedBadgeHtml(l)}
    <div class="emi-card-top">
      <span class="emi-card-id" style="color:${tc}">${l.loanId}</span>
      <div style="text-align:right">
        <div class="emi-card-date-big" style="color:${tc}">${rightDate}</div>
      </div>
    </div>
    <div class="emi-card-name" style="display:flex;justify-content:space-between;align-items:center;color:${tc};gap:8px">
      <span>${l.customerName}</span>
      ${overdueLabel ? `<span style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.85);flex-shrink:0">${overdueLabel}</span>` : ''}
    </div>
    <div class="emi-card-meta">
      <span class="emi-amt-pill" style="${pillStyle}">${billTxt ? 'Bill: '+billTxt : '—'}</span>
      <span class="emi-amt-pill" style="${pillStyle}">${fmtAmt(l.monthlyEmi)}/mo</span>
      ${l.model ? `<span class="emi-model-pill" style="${pillStyle}">${l.model}</span>` : ''}
      ${lateTxt ? `<span class="emi-late-pill" style="${pillStyle}">&#9888; ${lateTxt}</span>` : ''}
      ${hasPendingEmi ? `<span class="emi-late-pill" style="${pillStyle}">⏳ Pending</span>` : ''}
      ${partialIndicator(l, sc)}
    </div>
  </div>`;
}

async function openCdDetail(loanId) {
  showLoader();
  try {
  let l = S.sheetLoans && S.sheetLoans.find(x => x.loanId === loanId);
  if (!l) return;

  if (!S._fullLoaded && l._slim) {
    try {
      const data = await gasGet('readLoanDetail', { loanId });
      if (data.ok && data.loan) {
        const idx = S.sheetLoans.findIndex(x => x.loanId === loanId);
        if (idx !== -1) S.sheetLoans[idx] = data.loan;
        l = data.loan;
      }
    } catch(e) { console.warn('Could not load detail:', e.message); }
  }

  const akPct  = l.akShare  != null ? Math.round((l.akShare  <= 1 ? l.akShare  * 100 : l.akShare))  : 0;
  const aksPct = l.aksShare != null ? Math.round((l.aksShare <= 1 ? l.aksShare * 100 : l.aksShare)) : 0;

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

  let emiTableHtml = '';
  const slots2 = l.slots || [];
  if (slots2.length) {
    emiTableHtml = '<div><div style="font-size:12px;font-weight:600;color:#534AB7;margin-bottom:6px">EMI Schedule</div><table class="emi-table"><thead><tr><th>EMI</th><th>Received</th><th>Due Date</th><th>Rcvd Date</th><th>Misc</th><th>Cashflow</th></tr></thead><tbody>';
    slots2.forEach((s,i) => {
      const late2 = wasLateEmi(s);
      emiTableHtml += `<tr class="emi-tr${s.received?' rcvd':''}${late2?' late':''}"><td>${i+1}</td><td>${Bool(s.received)}</td><td>${s.scheduledDate?fmtDisplayDate(s.scheduledDate):'—'}</td><td>${s.receivedDate?fmtDisplayDate(s.receivedDate):'—'}${late2?' <span style="color:#BA7517;font-size:11px" title="Received late">⚠️ late</span>':''}</td><td>${s.misc?M(s.misc):'—'}</td><td>${s.cashflow?M(s.cashflow):'—'}</td></tr>`;
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
  $('cd-emi-schedule').innerHTML = emiTableHtml;
  const cdfEl = $('cd-fine-extra');
  if (cdfEl) {
    const fine = l.latePaymentFine || 0;
    const extra = l.extraEmiReceived || 0;
    cdfEl.innerHTML = (fine || extra) ? `<div style="display:flex;gap:16px;flex-wrap:wrap">
      ${fine ? `<span style="color:#A32D2D;font-weight:500">Late fine: ${fmtAmt(fine)}</span>` : ''}
      ${extra ? `<span style="color:#0F6E56;font-weight:500">Extra EMI: ${fmtAmt(extra)}</span>` : ''}
    </div>` : '';
  }
  $('cd-detail-kv').innerHTML = rows
    .filter(([label]) => !HIDDEN_LABELS.has(label))
    .map(([label, val]) => `<span class="kv-l">${label}</span><span class="kv-v">${val}</span>`
  ).join('');

  const panel = $('cd-detail-panel');
  panel.style.display = 'block';
  if ($('cd-detail-ph')) $('cd-detail-ph').style.display = 'none';
  if (window.matchMedia('(orientation: portrait)').matches)
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } finally { hideLoader(); }
}
function closeCdDetail() {
  $('cd-detail-panel').style.display = 'none';
  if ($('cd-detail-ph')) $('cd-detail-ph').style.display = '';
  document.querySelectorAll('#page-closed-defaulted .emi-card').forEach(c => c.classList.remove('selected'));
}

function wasLateEmi(slot) {
  if (!slot || !slot.received || !slot.receivedDate || !slot.scheduledDate) return false;
  const sd = parseSheetDate(slot.scheduledDate);
  const rd = parseSheetDate(slot.receivedDate);
  return sd && rd && rd > sd;
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

// ── Revised Date form ─────────────────────────────────────────────────────
function showRevisedDateForm() {
  if (!S.selectedEmiLoanId) return;
  const loan = (S.sheetLoans && S.sheetLoans.find(l => l.loanId === S.selectedEmiLoanId))
    || S.loans.find(l => l.loanId === S.selectedEmiLoanId);
  if (!loan) return;
  const duration = loan.emiDuration || 0;
  const nextNum = loan.numReceivedEmi + 1;
  if (nextNum > duration) return;

  // Populate EMI number dropdown with unreceived EMIs
  const sel = $('revised-emi-num');
  if (sel) {
    sel.innerHTML = '';
    for (let i = nextNum; i <= duration; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = 'EMI ' + i;
      if (i === nextNum) opt.selected = true;
      sel.appendChild(opt);
    }
  }
  // Prefill amount with monthly EMI
  const amtInput = $('revised-amt');
  if (amtInput) amtInput.value = loan.monthlyEmi || '';
  // Default date = today
  const dateInput = $('revised-date');
  if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
  // Clear note
  const noteInput = $('revised-note');
  if (noteInput) noteInput.value = '';
  // Show modal
  const modal = $('revised-date-modal');
  if (modal) modal.style.display = 'flex';
}

function closeRevisedDateForm() {
  const modal = $('revised-date-modal');
  if (modal) modal.style.display = 'none';
}

async function submitRevisedDate() {
  const loanId = S.selectedEmiLoanId;
  if (!loanId) return;
  const emiNum = parseInt($('revised-emi-num')?.value) || 0;
  const revisedDate = $('revised-date')?.value || '';
  const amount = parseFloat($('revised-amt')?.value) || 0;
  const note = $('revised-note')?.value?.trim() || '';
  if (!emiNum || !revisedDate || !amount) {
    showAlert('Please fill EMI number, revised date, and amount.', 'e');
    return;
  }
  closeRevisedDateForm();
  showLoader();
  try {
    const res = await gasPost({ action: 'setRevisedDate', loanId, emiNum, revisedDate, amount, note });
    if (res.ok) {
      if (res.pending) S.pending = res.pending;
      // Re-fetch revised dates
      try {
        const revData = await gasGet('readRevisedDates');
        if (revData.ok) S.revisedDates = revData.dates;
      } catch(e) { console.warn('Could not re-fetch revised dates:', e.message); }
      // Re-render loan detail and cards
      selectEmiLoan(loanId);
      rerenderActiveTab();
      renderApprovals($('appr-search') ? $('appr-search').value : '');
      showAlert('Revised date saved.');
    } else {
      showAlert('Failed to save revised date: ' + (res.error || 'Unknown error'), 'e');
    }
  } finally { hideLoader(); }
}

// ── OVERVIEW TAB (merged view) ────────────────────────────────────────────
const _ovViewCollapsed = { upcoming: false, overdue: false };
S.showOverviewRevised = false;
S.showOverviewPartials = false;
S.showOverviewOverdue = false;
S.showOverviewLoans = false;

function renderAllOverview(query) {
  try {
  if (!S.showOverviewRevised && !S.showOverviewPartials && !S.showOverviewOverdue && !S.showOverviewLoans) {
    const a = $('ov-allcards-toggle'); if (a) { a.style.background='#534AB7'; a.style.color='#fff'; }
  }
  console.log('renderAllOverview called, sheetLoans length:', S.sheetLoans ? S.sheetLoans.length : 0);
  const source = (S.sheetLoans && S.sheetLoans.length) ? S.sheetLoans
    : S.loans.map(l => ({
        loanId: l.loanId, customerName: l.data.customerName,
        monthlyEmi: l.data.monthlyEmi, nextEmiDate: '',
        billDate: l.data.billDate, lastEmiDate: l.data.lastEmiDate,
        status: l.closed ? 'Closed' : 'Active',
        isDefaulted: false, emiCompleted: l.closed,
        model: l.data.model, akShare: l.data.akShare / 100,
        aksShare: l.data.aksShare / 100, emiDuration: l.data.tenure,
        slots: [], numReceivedEmi: l.emis.length, lateEmis: 0, latePaymentFine: 0,
      }));

  // Show/hide revised view
  if (S.showOverviewRevised) {
    const tc = document.querySelector('.emi-five-col');
    if (tc) tc.style.display = 'none';
    const mt = $('ov-tabs');
    if (mt) mt.style.display = 'none';
    const rv = $('ov-revised-view');
    if (rv) rv.style.display = 'block';
    const pv = $('ov-partials-view');
    if (pv) pv.style.display = 'none';
    const ov = $('ov-overdue-view');
    if (ov) ov.style.display = 'none';
    renderOverviewRevised();
    return;
  } else {
    const tc = document.querySelector('.emi-five-col');
    if (tc) tc.style.display = '';
    const mt = $('ov-tabs');
    if (mt) mt.style.display = '';
    const rv = $('ov-revised-view');
    if (rv) rv.style.display = 'none';
  }

  // Show/hide partials view
  if (S.showOverviewPartials) {
    const tc = document.querySelector('.emi-five-col');
    if (tc) tc.style.display = 'none';
    const mt = $('ov-tabs');
    if (mt) mt.style.display = 'none';
    const pv = $('ov-partials-view');
    if (pv) pv.style.display = 'block';
    const rv = $('ov-revised-view');
    if (rv) rv.style.display = 'none';
    const ov = $('ov-overdue-view');
    if (ov) ov.style.display = 'none';
    renderOverviewPartials();
    return;
  } else {
    const pv = $('ov-partials-view');
    if (pv && !S.showOverviewRevised) pv.style.display = 'none';
  }

  // Show/hide loans view
  if (S.showOverviewLoans) {
    const tc = document.querySelector('.emi-five-col');
    if (tc) tc.style.display = 'none';
    const mt = $('ov-tabs');
    if (mt) mt.style.display = 'none';
    const rv = $('ov-revised-view');
    if (rv) rv.style.display = 'none';
    const pv = $('ov-partials-view');
    if (pv) pv.style.display = 'none';
    const ov = $('ov-overdue-view');
    if (ov) ov.style.display = 'none';
    const lv = $('ov-loans-view');
    if (lv) lv.style.display = 'block';
    renderOverviewLoans();
    return;
  } else {
    const lv = $('ov-loans-view');
    if (lv) lv.style.display = 'none';
  }

  // Show/hide overdue view
  if (S.showOverviewOverdue) {
    const tc = document.querySelector('.emi-five-col');
    if (tc) tc.style.display = 'none';
    const mt = $('ov-tabs');
    if (mt) mt.style.display = 'none';
    const rv = $('ov-revised-view');
    if (rv) rv.style.display = 'none';
    const pv = $('ov-partials-view');
    if (pv) pv.style.display = 'none';
    const ov = $('ov-overdue-view');
    if (ov) ov.style.display = 'block';
    renderOverviewOverdue();
    return;
  } else {
    const ov = $('ov-overdue-view');
    if (ov) ov.style.display = 'none';
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const q = (query || '').toLowerCase();

  const filtered = q ? source.filter(l => l.loanId.toLowerCase().includes(q) || (l.customerName||'').toLowerCase().includes(q) || (l.phone||'').includes(q) || (l.guarantor||'').toLowerCase().includes(q) || (l.model||'').toLowerCase().includes(q) || (l.aadhaarPan||'').toLowerCase().includes(q)) : source;

  const upcoming  = [];
  const overdue   = [];
  const closed    = [];
  const defaulted = [];

  filtered.forEach(l => {
    if (l.isDefaulted) { defaulted.push(l); return; }
    if (l.emiCompleted || l.status === 'Closed') { closed.push(l); return; }
    if (!l.nextEmiDate) { upcoming.push(l); return; }
    const due = new Date(l.nextEmiDate); due.setHours(0,0,0,0);
    if (due < today) overdue.push(l); else upcoming.push(l);
  });

  overdue.sort((a, b) => {
    const diff = new Date(b.nextEmiDate||'0') - new Date(a.nextEmiDate||'0');
    return diff !== 0 ? diff : a.loanId.localeCompare(b.loanId);
  });
  upcoming.sort((a, b) => {
    const diff = new Date(a.nextEmiDate||'9999') - new Date(b.nextEmiDate||'9999');
    return diff !== 0 ? diff : a.loanId.localeCompare(b.loanId);
  });
  closed.sort((a, b) => {
    const diff = new Date(b.lastEmiDate||'0') - new Date(a.lastEmiDate||'0');
    return diff !== 0 ? diff : a.loanId.localeCompare(b.loanId);
  });
  defaulted.sort((a, b) => {
    const diff = new Date(b.billDate||'0') - new Date(a.billDate||'0');
    return diff !== 0 ? diff : a.loanId.localeCompare(b.loanId);
  });

  $('ov-all-count').textContent = upcoming.length + overdue.length + closed.length + defaulted.length;
  $('ov-upcoming-count').textContent  = upcoming.length;
  $('ov-overdue-count').textContent   = overdue.length;
  $('ov-closed-count').textContent    = closed.length;
  $('ov-defaulted-count').textContent = defaulted.length;

  const noDataMsg = (!S.sheetLoans || !S.sheetLoans.length) ? '<div class="emi-col-empty">Fetching from Sheets…</div>' : '';
  const allCards = [...overdue.map(l => overviewCard(l, 'overdue')), ...upcoming.map(l => overviewCard(l, 'upcoming')), ...defaulted.map(l => overviewCard(l, 'defaulted')), ...closed.map(l => overviewCard(l, 'closed'))];
  $('ov-all-list').innerHTML       = allCards.length ? allCards.join('') : (noDataMsg || '<div class="emi-col-empty">No loans</div>');
  $('ov-upcoming-list').innerHTML  = upcoming.length  ? upcoming.map(l  => overviewCard(l, 'upcoming')).join('')  : (noDataMsg || '<div class="emi-col-empty">No upcoming EMIs</div>');
  $('ov-overdue-list').innerHTML   = overdue.length   ? overdue.map(l   => overviewCard(l, 'overdue')).join('')   : (noDataMsg || '<div class="emi-col-empty">All clear ✓</div>');
  $('ov-closed-list').innerHTML    = closed.length    ? closed.map(l    => overviewCard(l, 'closed')).join('')    : (noDataMsg || '<div class="emi-col-empty">No closed loans</div>');
  $('ov-defaulted-list').innerHTML = defaulted.length ? defaulted.map(l => overviewCard(l, 'defaulted')).join('') : (noDataMsg || '<div class="emi-col-empty">No defaulted loans</div>');
} catch(e) { console.error('renderAllOverview error:', e); }
}

function overviewCard(l, type) {
  const today = new Date(); today.setHours(0,0,0,0);
  const billTxt = l.billDate ? fmtDisplayDate(l.billDate) : '';
  const lateTxt = l.lateEmis ? l.lateEmis + '/' + l.numReceivedEmi + ' late' : '';
  const hasPendingEmi = (S.pending && S.pending.some(p => p.type==='emi' && p.data.loanId===l.loanId && p.status==='pending'))
    || Object.keys(S._submittedEmis || {}).some(k => k.startsWith(l.loanId + '_'));
  let bg = '', border = '', tc = '#1a1a1a', sc = '#888', overdueLabel = '';
  let rightDate = '';

  if (type === 'upcoming' || type === 'overdue') {
    if (l.nextEmiDate) {
      const due = new Date(l.nextEmiDate); due.setHours(0,0,0,0);
      const days = Math.round((today - due) / 86400000);
      rightDate = 'Due: ' + fmtDisplayDate(l.nextEmiDate);
      if (days > 90)        { bg='#000';border='#000';tc='#fff';sc='rgba(255,255,255,0.75)';overdueLabel='90+ days overdue'; }
      else if (days > 30)   { bg='#980000';border='#980000';tc='#fff';sc='rgba(255,255,255,0.75)';overdueLabel='30+ days overdue'; }
      else if (days > 0)    { bg='#dd7e6b';border='#dd7e6b';tc='#fff';sc='rgba(255,255,255,0.75)';overdueLabel=days+'d overdue'; }
      else if (due.getTime()===today.getTime()) { bg='#ff9900';border='#ff9900';tc='#fff';sc='rgba(255,255,255,0.75)';overdueLabel='Due today'; }
    } else {
      rightDate = '—';
    }
  } else if (type === 'closed') {
    rightDate = '✓ Closed';
    tc = '#27500A';
  } else {
    rightDate = '⚠️ Defaulted';
    tc = '#A32D2D';
  }

  const cardStyle = bg ? `background:${bg};border-left-color:${border};border-color:${border}` : '';
  const pillStyle = bg ? 'background:rgba(255,255,255,0.2);color:#fff' : '';

  return `<div class="emi-card ${type}" data-loanid="${l.loanId}" style="cursor:pointer;${cardStyle}">
    ${revisedBadgeHtml(l)}
    <div class="emi-card-top">
      <span class="emi-card-id" style="color:${tc}">${l.loanId}</span>
      <div style="text-align:right">
        <div class="emi-card-date-big" style="color:${tc}">${rightDate}</div>
      </div>
    </div>
    <div class="emi-card-name" style="display:flex;justify-content:space-between;align-items:center;color:${tc};gap:8px">
      <span>${l.customerName}</span>
      ${overdueLabel ? `<span style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.85);flex-shrink:0">${overdueLabel}</span>` : ''}
    </div>
    <div class="emi-card-meta">
      <span class="emi-amt-pill" style="${pillStyle}">${billTxt ? 'Bill: '+billTxt : '—'}</span>
      <span class="emi-amt-pill" style="${pillStyle}">${fmtAmt(l.monthlyEmi)}/mo</span>
      ${l.model ? `<span class="emi-model-pill" style="${pillStyle}">${l.model}</span>` : ''}
      ${lateTxt ? `<span class="emi-late-pill" style="${pillStyle}">&#9888; ${lateTxt}</span>` : ''}
      ${partialIndicator(l, sc)}
    </div>
  </div>`;
}

// Click handler for overview cards
document.addEventListener('click', function(e) {
  const card = e.target.closest('#page-all-loans .emi-card[data-loanid]');
  if (card) {
    const loanId = card.dataset.loanid;
    selectOverviewLoan(loanId);
  }
});

async function selectOverviewLoan(loanId) {
  showLoader();
  try {
    document.querySelectorAll('#page-all-loans .emi-card').forEach(r => r.classList.remove('selected'));
    document.querySelectorAll(`#page-all-loans .emi-card[data-loanid="${loanId}"]`).forEach(r => r.classList.add('selected'));
    S.selectedEmiLoanId = loanId;

    let loan = (S.sheetLoans && S.sheetLoans.find(l => l.loanId === loanId))
      || (() => { const l = S.loans.find(l => l.loanId === loanId); return l ? { ...l.data, status:'Active', slots:l.emis||[], numReceivedEmi: (l.emis||[]).length } : null; })();
    if (!loan) return;

    if (!S._fullLoaded && loan._slim) {
      try {
        const data = await gasGet('readLoanDetail', { loanId });
        if (data.ok && data.loan) {
          const idx = S.sheetLoans.findIndex(l => l.loanId === loanId);
          if (idx !== -1) S.sheetLoans[idx] = data.loan;
          loan = data.loan;
        }
      } catch(e) { console.warn('Could not load detail:', e.message); }
    }

    $('ov-detail-loanid').textContent = loanId;
    $('ov-detail-sub').textContent    = loan.customerName || '';

    const detail = $('ov-detail');
    detail.style.display = 'block';
    if ($('ov-detail-ph')) $('ov-detail-ph').style.display = 'none';
    if (window.matchMedia('(orientation: portrait)').matches)
      detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    const akPct  = Math.round((loan.akShare  || 0) * 100);
    const aksPct = Math.round((loan.aksShare || 0) * 100);

    $('ov-detail-kv').innerHTML = `
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

    // EMI history — tabular
    const duration = loan.emiDuration || 0;
    const slots    = loan.slots || [];
    const today2 = new Date(); today2.setHours(0,0,0,0);
    const pendingSet = new Set(
      S.pending.filter(p => p.type==='emi' && p.data.loanId===loanId && p.status==='pending')
        .map(p => Number(p.data.emiNum))
    );
    Object.keys(S._submittedEmis || {}).forEach(k => {
      if (k.startsWith(loanId + '_')) pendingSet.add(parseInt(k.split('_')[1]));
    });
    [...pendingSet].forEach(n => {
      if (loan.slots && loan.slots[n-1] && loan.slots[n-1].received) {
        delete S._submittedEmis[loanId + '_' + n];
        pendingSet.delete(n);
      }
    });
    if (duration > 0) {
      let tableHtml = '<table class="emi-table"><thead><tr><th>EMI</th><th>Status</th><th>Due Date</th><th>Rcvd Date</th><th>Amount</th><th>Misc</th><th>Reason</th></tr></thead><tbody>';
      for (let i = 0; i < duration && i < 8; i++) {
        const slot = slots[i] || { num:i+1, received:false, scheduledDate:'', receivedDate:'', misc:0, cashflow:0 };
        const scheduledTxt = slot.scheduledDate ? fmtDisplayDate(slot.scheduledDate) : '—';
        const lateEmi = wasLateEmi(slot);
        const receivedTxt  = slot.receivedDate  ? fmtDisplayDate(slot.receivedDate) + (lateEmi ? ' <span style="color:#BA7517;font-size:11px" title="Received late">⚠️ late</span>' : '') : '—';
        let statusHtml = '', rowClass = '';
        if (slot.received) {
          statusHtml = '<span class="badge b-approved">Received</span>';
          rowClass = ' rcvd' + (lateEmi ? ' late' : '');
        }
        if (pendingSet.has(i+1)) statusHtml += ' <span class="badge b-pending" style="font-size:10px">⏳ Pending</span>';
        const miscTxt = slot.misc !== 0 ? fmtAmt(slot.misc) : '—';
        const reason = slot.miscType || (pendingSet.has(i+1) ? (S.pending.find(p => p.type==='emi' && p.data.loanId===loanId && p.status==='pending' && Number(p.data.emiNum)===i+1)?.data?.reason || '—') : '—');
        tableHtml += `<tr class="emi-tr${rowClass}"><td>${i+1}</td><td>${statusHtml}</td><td>${scheduledTxt}</td><td>${receivedTxt}</td><td>${fmtAmt(slot.cashflow)}</td><td>${miscTxt}</td><td style="font-size:11px;color:#555">${reason}</td></tr>`;
      }
      tableHtml += '</tbody></table>';
      $('ov-emi-slots').innerHTML = tableHtml;
      $('ov-emi-slots-wrap').style.display = 'block';
    } else {
      $('ov-emi-slots').innerHTML = '';
      $('ov-emi-slots-wrap').style.display = 'none';
    }

    // Late fine & extra EMI
    const fineEl = $('ov-fine-extra');
    if (fineEl) {
      const fine = loan.latePaymentFine || 0;
      const extra = loan.extraEmiReceived || 0;
      fineEl.innerHTML = (fine || extra) ? `<div style="display:flex;gap:16px;flex-wrap:wrap">
        ${fine ? `<span style="color:#A32D2D;font-weight:500">Late fine: ${fmtAmt(fine)}</span>` : ''}
        ${extra ? `<span style="color:#0F6E56;font-weight:500">Extra EMI: ${fmtAmt(extra)}</span>` : ''}
      </div>` : '';
    }

    // Partial banner
    const bannerEl = $('ov-partial-banner');
    if (bannerEl) {
      const partialItems = S.approvedPartials.filter(p => p.loanId === loanId);
      if (partialItems.length) {
        let h = '<div style="font-size:12px;font-weight:500;color:#A32D2D;margin-bottom:6px">Approved Partial Payments</div>';
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

    // Revised stats
    const statsEl = $('ov-revised-stats');
    const btnWrap = $('ov-revised-btn-wrap');
    if (statsEl) {
      const customerPrefix = loan.loanId.split('/')[0];
      const dates = S.revisedDates || [];
      const emiCount = dates.filter(d => d.loanId === loanId && d.emiNum === loan.numReceivedEmi + 1).length;
      const loanCount = dates.filter(d => d.loanId === loanId).length;
      const customerCount = dates.filter(d => d.loanId.split('/')[0] === customerPrefix).length;
      if (loanCount > 0) {
        statsEl.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap;padding:6px 0">
          <span style="color:#399C9C;font-weight:500">Revised Date Revisions:</span>
          <span>This EMI: <strong>${emiCount}</strong></span>
          <span>This Loan: <strong>${loanCount}</strong></span>
          <span>This Customer: <strong>${customerCount}</strong></span>
        </div>`;
      } else {
        statsEl.innerHTML = '';
      }
    }
    if (btnWrap) {
      btnWrap.style.display = (loan.numReceivedEmi < duration) ? '' : 'none';
      btnWrap.dataset.monthlyEmi = loan.monthlyEmi || '';
      btnWrap.dataset.duration = duration;
    }

    const nextNum = loan.numReceivedEmi + 1;
    const emiFormWrap = $('ov-emi-form-wrap');

    if (nextNum > duration) {
      $('ov-next-label').textContent = 'All EMIs collected!';
      if (emiFormWrap) emiFormWrap.style.display = 'none';
    } else {
      if (emiFormWrap) emiFormWrap.style.display = '';
      const extraReceived = loan.extraEmiReceived || 0;
      const expectedAmt   = Math.max(0, (loan.monthlyEmi || 0) - extraReceived);
      $('ov-next-label').textContent = `Recording: EMI ${nextNum} of ${duration} · Standard EMI: ${fmtAmt(loan.monthlyEmi)}${extraReceived ? ' · Expected to collect: ' + fmtAmt(expectedAmt) : ''}`;

      // Prefill
      $('ov-emi-amt').value  = loan.monthlyEmi || '';
      $('ov-emi-date').value = new Date().toISOString().split('T')[0];
      $('ov-emi-notes').value  = '';
      $('ov-emi-reason').value = '';
      $('ov-emi-reason-wrap').style.display = 'none';
      $('ov-emi-diff-warn').style.display   = 'none';

      const subBtn = $('ov-emi-submit-btn');
      if (pendingSet.has(nextNum)) {
        subBtn.disabled = true;
        subBtn.style.opacity = '0.5';
        subBtn.style.cursor = 'not-allowed';
        $('ov-next-label').textContent = '⚠ EMI ' + nextNum + ' already pending approval.';
      } else {
        subBtn.disabled = false;
        subBtn.style.opacity = '';
        subBtn.style.cursor = '';
      }
    }

    // Revised date next field
    const revWrap = $('ov-emi-revised-next-wrap');
    const revDt   = $('ov-emi-next-revised-date');
    if (revWrap && revDt) {
      const hasRevForCurrEmi = (S.revisedDates||[]).some(d => d.loanId === loanId && d.emiNum === nextNum);
      if (hasRevForCurrEmi && nextNum < duration) {
        revWrap.style.display = 'block';
        const loanRevs = (S.revisedDates||[]).filter(d => d.loanId === loanId && d.revisedDate);
        let latest = null;
        loanRevs.forEach(d => { const dt = parseSheetDate(d.revisedDate); if (dt && (!latest || dt > latest)) latest = dt; });
        if (latest) {
          const next = new Date(latest);
          next.setMonth(next.getMonth() + 1);
          revDt.value = next.getFullYear() + '-' + String(next.getMonth()+1).padStart(2,'0') + '-' + String(next.getDate()).padStart(2,'0');
        } else {
          revDt.value = '';
        }
      } else {
        revWrap.style.display = 'none';
        revDt.value = '';
      }
    }
    // Loan Details — full 87 columns (same as All Loans tab)
    const Df = (v) => (v === 'Invalid Date') ? '—' : (v || '—');
    const Mf = (v) => (v == null || v === '') ? '—' : '₹' + Number(v).toLocaleString('en-IN');
    const Dtf = (v) => v ? fmtDisplayDate(v) : '—';
    const Pctf = (v) => v != null && v !== '' ? v + '%' : '—';
    const Boolf = (v) => v === true ? 'Yes' : v === false ? 'No' : '—';

    const fullRows = [
      ['Bill Date',                    Dtf(loan.billDate)],
      ['Loan ID',                      Df(loan.loanId)],
      ['Customer Name',                Df(loan.customerName)],
      ['Customer Mobile No',           Df(loan.phone)],
      ['Customer AADHAR / PAN',        Df(loan.aadhaarPan)],
      ['Mobile Model',                 Df(loan.model)],
      ['Device Type',                  Df(loan.deviceType)],
      ['Mobile Amount',                Mf(loan.mobileAmount)],
      ['Down Payment',                 Mf(loan.downPayment)],
      ['Processing Fee',               Mf(loan.processingFee)],
      ['Interest',                     Mf(loan.interest)],
      ['EMI Duration',                 loan.emiDuration ? loan.emiDuration + ' months' : '—'],
      ['EMI Start Date',               Dtf(loan.emiStartDate)],
      ['Total Amount',                 Mf(loan.totalAmount)],
      ['Total EMI',                    Df(loan.totalEmi)],
      ['Monthly EMI',                  Mf(loan.monthlyEmi)],
      ['Customer ID',                  Df(loan.customerId)],
      ['Guarantor / Alternate No',     Df(loan.guarantor)],
      ['Max Interest Discount',        Mf(loan.maxInterestDiscount)],
      ['Rate of Interest',             Pctf(loan.rateOfInterest)],
      ['Finance Amount',               Mf(loan.financeAmount)],
      ['App Lock Charge',              Mf(loan.appLockCharge)],
      ['AK Share',                     akPct + '%'],
      ['AKS Share',                    aksPct + '%'],
      ['AK Amount',                    Mf(loan.akAmount)],
      ['AK Paid to Kunal',             Mf(loan.akPaidToKunal)],
      ['AKS Amount',                   Mf(loan.aksAmount)],
      ['AKS Paid to Kunal',            Mf(loan.aksPaidToKunal)],
      ['Next EMI Date',                Dtf(loan.nextEmiDate)],
      ['Last EMI Date',                Dtf(loan.lastEmiDate)],
      ['Remaining Principal',          Mf(loan.remainingPrincipal)],
      ['Remaining Interest',           Mf(loan.remainingInterest)],
      ['Total Pending',                Mf(loan.totalPending)],
      ['Received Principal',           Mf(loan.receivedPrincipal)],
      ['Received Interest',            Mf(loan.receivedInterest)],
      ['Received Total',               Mf(loan.receivedTotal)],
      ['Number of Received EMI',       Df(loan.numReceivedEmi)],
      ['EMI Completed',                Boolf(loan.emiCompleted)],
      ['Late EMIs',                    Df(loan.lateEmis)],
      ['Late Payment Fine',            Mf(loan.latePaymentFine)],
      ['Early Loan Closing Settlement',Mf(loan.earlyClosing)],
      ['Extra EMI Received',           Mf(loan.extraEmiReceived)],
      ['Recovery Charge',              Mf(loan.recoveryCharge)],
      ['Welcome Message Sent',         Boolf(loan.welcomeMsg)],
      ['Loan Closing Message Sent',    Boolf(loan.closingMsg)],
      ['Lock App Removed',             Boolf(loan.lockRemoved)],
      ['Defaulted',                    Boolf(loan.isDefaulted)],
      ['Default Comment',              Df(loan.defaultComment)],
      ['Final ROI',                    Pctf(loan.finalRoi)],
      ['AK Share of EMI',              Mf(loan.akShareOfEmi)],
      ['AKS Share of EMI',             Mf(loan.aksShareOfEmi)],
      ['Drive Link',                   loan.driveLink ? '<a href="'+loan.driveLink+'" target="_blank" style="color:#534AB7">Open ↗</a>' : '—'],
      ['Down Payment %',               Df(loan.downPaymentPct)],
    ];

    const HIDDEN_LABELS = new Set([
      'Rate of Interest', 'App Lock Charge', 'AK Share', 'AKS Share',
      'AK Amount', 'AK Paid to Kunal', 'AKS Amount', 'AKS Paid to Kunal',
      'Remaining Principal', 'Remaining Interest', 'Received Principal', 'Received Interest',
      'Late Payment Fine', 'Early Loan Closing Settlement', 'Extra EMI Received',
      'Recovery Charge', 'Welcome Message Sent', 'Loan Closing Message Sent',
      'Default Comment', 'Final ROI', 'AK Share of EMI', 'AKS Share of EMI',
      'Drive Link', 'Down Payment %',
    ]);

    $('ov-detail-full').innerHTML = fullRows
      .filter(([label]) => !HIDDEN_LABELS.has(label))
      .map(([label, val]) => `<span class="kv-l">${label}</span><span class="kv-v">${val}</span>`
    ).join('');
  } finally { hideLoader(); }
}

function closeOverviewDetail() {
  $('ov-detail').style.display = 'none';
  if ($('ov-detail-ph')) $('ov-detail-ph').style.display = '';
  S.selectedEmiLoanId = null;
  document.querySelectorAll('#page-all-loans .emi-card').forEach(r => r.classList.remove('selected'));
  if ($('ov-emi-received')) $('ov-emi-received').value = 'true';
}

function toggleOverviewAllCards() {
  S.showOverviewRevised = false;
  S.showOverviewPartials = false;
  S.showOverviewOverdue = false;
  S.showOverviewLoans = false;
  $('ov-allcards-toggle').style.background = '#534AB7';
  $('ov-allcards-toggle').style.color = '#fff';
  const rbtn = $('ov-revised-toggle');
  if (rbtn) { rbtn.style.background = 'none'; rbtn.style.color = '#D4A017'; }
  const pbtn = $('ov-partials-toggle');
  if (pbtn) { pbtn.style.background = 'none'; pbtn.style.color = '#A32D2D'; }
  const obtn = $('ov-overdue-toggle');
  if (obtn) { obtn.style.background = 'none'; obtn.style.color = '#c62828'; }
  const lbtn = $('ov-loans-toggle');
  if (lbtn) { lbtn.style.background = 'none'; lbtn.style.color = '#0F6E56'; }
  renderAllOverview($('ov-search') ? $('ov-search').value : '');
}

function toggleOverviewRevised() {
  S.showOverviewRevised = !S.showOverviewRevised;
  S.showOverviewPartials = false;
  S.showOverviewOverdue = false;
  S.showOverviewLoans = false;
  const abtn = $('ov-allcards-toggle');
  if (abtn) { abtn.style.background = S.showOverviewRevised ? 'none' : '#534AB7'; abtn.style.color = S.showOverviewRevised ? '#534AB7' : '#fff'; }
  const btn = $('ov-revised-toggle');
  if (btn) {
    btn.style.background = S.showOverviewRevised ? '#D4A017' : 'none';
    btn.style.color = S.showOverviewRevised ? '#fff' : '#D4A017';
  }
  const pbtn = $('ov-partials-toggle');
  if (pbtn) { pbtn.style.background = 'none'; pbtn.style.color = '#A32D2D'; }
  const obtn = $('ov-overdue-toggle');
  if (obtn) { obtn.style.background = 'none'; obtn.style.color = '#c62828'; }
  const lbtn = $('ov-loans-toggle');
  if (lbtn) { lbtn.style.background = 'none'; lbtn.style.color = '#0F6E56'; }
  renderAllOverview($('ov-search') ? $('ov-search').value : '');
}

function toggleOverviewPartials() {
  S.showOverviewPartials = !S.showOverviewPartials;
  S.showOverviewRevised = false;
  S.showOverviewOverdue = false;
  S.showOverviewLoans = false;
  const abtn = $('ov-allcards-toggle');
  if (abtn) { abtn.style.background = S.showOverviewPartials ? 'none' : '#534AB7'; abtn.style.color = S.showOverviewPartials ? '#534AB7' : '#fff'; }
  const rbtn = $('ov-revised-toggle');
  if (rbtn) { rbtn.style.background = 'none'; rbtn.style.color = '#D4A017'; }
  const btn = $('ov-partials-toggle');
  if (btn) {
    btn.style.background = S.showOverviewPartials ? '#A32D2D' : 'none';
    btn.style.color = S.showOverviewPartials ? '#fff' : '#A32D2D';
  }
  const obtn = $('ov-overdue-toggle');
  if (obtn) { obtn.style.background = 'none'; obtn.style.color = '#c62828'; }
  const lbtn = $('ov-loans-toggle');
  if (lbtn) { lbtn.style.background = 'none'; lbtn.style.color = '#0F6E56'; }
  renderAllOverview($('ov-search') ? $('ov-search').value : '');
}

function toggleOverviewOverdue() {
  S.showOverviewOverdue = !S.showOverviewOverdue;
  S.showOverviewRevised = false;
  S.showOverviewPartials = false;
  S.showOverviewLoans = false;
  const abtn = $('ov-allcards-toggle');
  if (abtn) { abtn.style.background = S.showOverviewOverdue ? 'none' : '#534AB7'; abtn.style.color = S.showOverviewOverdue ? '#534AB7' : '#fff'; }
  const rbtn = $('ov-revised-toggle');
  if (rbtn) { rbtn.style.background = 'none'; rbtn.style.color = '#D4A017'; }
  const pbtn = $('ov-partials-toggle');
  if (pbtn) { pbtn.style.background = 'none'; pbtn.style.color = '#A32D2D'; }
  const btn = $('ov-overdue-toggle');
  if (btn) {
    btn.style.background = S.showOverviewOverdue ? '#c62828' : 'none';
    btn.style.color = S.showOverviewOverdue ? '#fff' : '#c62828';
  }
  const lbtn = $('ov-loans-toggle');
  if (lbtn) { lbtn.style.background = 'none'; lbtn.style.color = '#0F6E56'; }
  renderAllOverview($('ov-search') ? $('ov-search').value : '');
}

function toggleOverviewLoans() {
  S.showOverviewLoans = !S.showOverviewLoans;
  S.showOverviewRevised = false;
  S.showOverviewPartials = false;
  S.showOverviewOverdue = false;
  const abtn = $('ov-allcards-toggle');
  if (abtn) { abtn.style.background = S.showOverviewLoans ? 'none' : '#534AB7'; abtn.style.color = S.showOverviewLoans ? '#534AB7' : '#fff'; }
  const rbtn = $('ov-revised-toggle');
  if (rbtn) { rbtn.style.background = 'none'; rbtn.style.color = '#D4A017'; }
  const pbtn = $('ov-partials-toggle');
  if (pbtn) { pbtn.style.background = 'none'; pbtn.style.color = '#A32D2D'; }
  const obtn = $('ov-overdue-toggle');
  if (obtn) { obtn.style.background = 'none'; obtn.style.color = '#c62828'; }
  const btn = $('ov-loans-toggle');
  if (btn) {
    btn.style.background = S.showOverviewLoans ? '#0F6E56' : 'none';
    btn.style.color = S.showOverviewLoans ? '#fff' : '#0F6E56';
  }
  renderAllOverview($('ov-search') ? $('ov-search').value : '');
}

function renderOverviewLoans() {
  const el = $('ov-loans-view');
  if (!el) return;
  const source = (S.sheetLoans && S.sheetLoans.length) ? S.sheetLoans : [];
  const q = ($('ov-search') ? $('ov-search').value : '').toLowerCase();
  let loans = q ? source.filter(l => l.loanId.toLowerCase().includes(q) || (l.customerName||'').toLowerCase().includes(q)) : source;
  loans = [...loans]; // copy
  loans.sort((a, b) => {
    const da = a.billDate ? new Date(a.billDate) : new Date(0);
    const db = b.billDate ? new Date(b.billDate) : new Date(0);
    return db - da || (a.customerName||'').localeCompare(b.customerName||'');
  });
  if (!loans.length) {
    el.innerHTML = '<div class="emi-col-empty">No loans</div>';
    return;
  }
  let cardHtml = '';
  for (let i = 0; i < loans.length; i++) {
    const l = loans[i];
    const sameDate = i > 0 && l.billDate === loans[i-1].billDate;
    const amtTxt = l.monthlyEmi ? fmtAmt(l.monthlyEmi) : '—';
    const cardIndent = sameDate ? 'margin-left:16px' : '';
    const rightShift = sameDate ? 'margin-left:-16px;' : '';
    cardHtml += `<div class="emi-card" data-loanid="${l.loanId}" style="cursor:pointer;background:#0F6E56;border-left:3px solid rgba(255,255,255,0.3);border:1px solid #0F6E56;margin-bottom:4px;padding:8px 10px;${cardIndent}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;height:14px">
        <span style="font-size:11px;font-weight:500;color:#fff;flex:0 0 auto;white-space:nowrap;line-height:14px">${l.billDate ? fmtDisplayDate(l.billDate) : '—'}</span>
        <div style="display:flex;flex:1;align-items:center;gap:8px;${rightShift}">
          <span style="flex:0 0 172px;line-height:14px;text-align:center"><span style="font-size:10px;font-weight:600;color:#0F6E56;background:#fff;padding:0 6px;border-radius:8px;white-space:nowrap">${amtTxt}/mo</span></span>
          <span style="font-weight:500;font-size:12px;color:#fff;flex:0 0 auto;line-height:14px">${l.customerName}</span>
          <span style="font-size:11px;color:rgba(255,255,255,0.75);text-align:right;flex:1 1 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:14px">${l.model || ''}</span>
        </div>
      </div>
    </div>`;
  }
  el.innerHTML = `<div style="font-size:12px;color:#888;margin-bottom:0.5rem">${loans.length} loan(s) sorted by bill date ▼</div>
    <div style="overflow-x:auto;overflow-y:hidden"><div style="min-width:max-content">${cardHtml}</div></div>`;
}

function checkOverviewEmiDiff() {
  const loanId = S.selectedEmiLoanId; if (!loanId) return;
  let loan = (S.sheetLoans && S.sheetLoans.find(l => l.loanId === loanId)) || S.loans.find(l => l.loanId === loanId);
  if (!loan) return;
  const stdEmi  = loan.monthlyEmi || loan?.data?.monthlyEmi || 0;
  const got     = parseFloat($('ov-emi-amt').value) || 0;
  if (!got) return;
  const diff = got - stdEmi;
  if (Math.abs(diff) > 1) {
    $('ov-emi-reason-wrap').style.display = 'block';
    $('ov-emi-diff-warn').style.display   = 'block';
    $('ov-emi-diff-msg').textContent = `Differs from standard EMI ${fmtAmt(stdEmi)} by ${diff>0?'+':''}${fmtAmt(Math.abs(diff))}. Please select a reason.`;
  } else {
    $('ov-emi-reason-wrap').style.display = 'none';
    $('ov-emi-diff-warn').style.display   = 'none';
  }
}

async function submitOverviewEmi() {
  if (S.cu.role !== 'admin' && !S.cu.perms.submit) { showAlert('Permission denied. You do not have submit for approval access.', 'e'); return; }
  const loanId = S.selectedEmiLoanId;
  if (!loanId) { showAlert('Please select a loan first.', 'e'); return; }
  let loan = S.sheetLoans && S.sheetLoans.find(l => l.loanId === loanId);
  if (!loan) loan = (() => { const l = S.loans.find(l => l.loanId === loanId); return l ? { ...l.data, status:'Active', slots:l.emis||[], numReceivedEmi: (l.emis||[]).length } : null; })();
  if (!loan) { showAlert('Loan data not found.', 'e'); return; }
  const nextNum = (loan.numReceivedEmi || 0) + 1;
  if (nextNum > (loan.emiDuration || 0)) { showAlert('All EMIs already collected for this loan.', 'e'); return; }
  const amt  = parseFloat($('ov-emi-amt').value) || 0;
  const date = $('ov-emi-date') ? $('ov-emi-date').value : '';
  if (!amt || !date) { showAlert('Please enter amount and payment date.', 'e'); return; }

  // Warn if scheduled date is far in the future
  if (loan.emiStartDate) {
    const parts = String(loan.emiStartDate).match(/(\d{1,2})[\-\/](\w{3})[\-\/](\d{2,4})/);
    if (parts) {
      const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
      const sd = new Date(parseInt(parts[3])<100?2000+parseInt(parts[3]):parseInt(parts[3]), months[parts[2].toLowerCase()], parseInt(parts[1]));
      sd.setMonth(sd.getMonth() + (nextNum - 1));
      const td = new Date(); td.setHours(0,0,0,0);
      const diff = Math.round((sd - td) / (1000*60*60*24));
      if (diff > 10) {
        if (!confirm('Scheduled date for EMI ' + nextNum + ' is ' + diff + ' days from now. Are you sure?')) return;
      }
    }
  }

  const extraRcv = loan.extraEmiReceived || 0;
  const stdEmi   = loan.monthlyEmi || 0;
  const expected = Math.max(0, stdEmi - extraRcv);
  if (Math.abs(amt - stdEmi) > 1 && !v('ov-emi-reason')) { showAlert('Please select a reason for the amount difference.', 'e'); return; }
  const numReceived = loan.numReceivedEmi || 0;
  const emiNum       = numReceived + 1;
  const emiStartDate = loan.emiStartDate || '';
  let scheduledDate  = '';
  if (emiStartDate) {
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
  const receivedVal = $('ov-emi-received') ? $('ov-emi-received').value !== 'false' : true;
  const d = {
    loanId,
    customerName:   loan.customerName || '',
    model:          loan.model || '',
    emiNum,
    amount:         amt, expectedAmount: stdEmi, misc: amt - stdEmi,
    date, scheduledDate, emiStartDate,
    received: receivedVal,
    mode: $('ov-emi-mode') ? $('ov-emi-mode').value : 'Cash',
    reason: $('ov-emi-reason') ? $('ov-emi-reason').value : '',
    notes: $('ov-emi-notes') ? $('ov-emi-notes').value : '',
    akShare:  Math.round((loan.akShare  || 0) * 100),
    aksShare: Math.round((loan.aksShare || 0) * 100),
  };
  const emiItem = { id: nextPid(), type: 'emi', data: d, submittedBy: S.cu.id, submittedAt: new Date().toISOString(), status: 'pending', note: '' };
  showAlert('Submitting…', 'w');
  showLoader();
  try {
    if (S.sheetsUrl) {
      const res = await gasPost({action:'saveEmi', item:emiItem});
      if (res.ok) {
        S._submittedEmis[loanId + '_' + emiNum] = true;
        if (res.pending) S.pending = res.pending;
        const revDt = $('ov-emi-next-revised-date');
        if (revDt && revDt.value && emiNum < (loan.emiDuration || 0)) {
          const nextNum2 = emiNum + 1;
          const nextAmt = loan.monthlyEmi || 0;
          const revRes = await gasPost({ action: 'setRevisedDate', loanId, emiNum: nextNum2, revisedDate: revDt.value, amount: nextAmt || 0, note: '' });
          if (revRes.ok) {
            try { const rd2 = await gasGet('readRevisedDates'); if (rd2.ok) S.revisedDates = rd2.dates; } catch(e) {}
          }
        }
        refreshNav();
        rerenderActiveTab();
        showAlert('EMI payment submitted for approval.');
      } else {
        await fetchPendingFromSheets();
        showAlert('Submission failed: ' + (res.error || 'Unknown error'), 'e');
      }
    }
  } finally { hideLoader(); }
  closeOverviewDetail();
}

function clearOverviewRevisedDateField() {
  const dt = $('ov-emi-next-revised-date');
  if (dt) dt.value = '';
}

window.__ovToggle = function(label) {
  _ovViewCollapsed[label] = !_ovViewCollapsed[label];
  renderOverviewRevised();
};

function renderOverviewRevised() {
  const el = $('ov-revised-view');
  if (!el) return;
  const q = (($('ov-search') ? $('ov-search').value : '') || '').toLowerCase();
  const source = (S.sheetLoans && S.sheetLoans.length) ? S.sheetLoans : [];
  const filtered = q ? source.filter(l => l.loanId.toLowerCase().includes(q) || (l.customerName||'').toLowerCase().includes(q)) : source;
  const today = new Date(); today.setHours(0,0,0,0);
  const hasRevDates = filtered.filter(l => {
    const revs = S.revisedDates.filter(rd => rd.loanId === l.loanId);
    return revs.some(rd => {
      if (rd.note === 'Mobile Jabt') return true;
      const slot = (l.slots || []).find(s => s.num === rd.emiNum);
      return !slot || !slot.received;
    });
  });
  const upcoming = [], overdue = [], mobileJabt = [];
  hasRevDates.forEach(l => {
    const hasJabt = S.revisedDates.some(rd => rd.loanId === l.loanId && rd.note === 'Mobile Jabt');
    if (hasJabt) { mobileJabt.push(l); return; }
    const dates = S.revisedDates.filter(rd => rd.loanId === l.loanId && rd.revisedDate);
    let latest = null;
    dates.forEach(d => { const dt = parseSheetDate(d.revisedDate); if (dt && (!latest || dt > latest)) latest = dt; });
    if (!latest) { upcoming.push(l); return; }
    if (latest >= today) upcoming.push(l); else overdue.push(l);
  });
  const getLastRev = (lid) => { let m = null; S.revisedDates.filter(rd => rd.loanId === lid && rd.revisedDate).forEach(d => { const dt = parseSheetDate(d.revisedDate); if (dt && (!m || dt > m)) m = dt; }); return m; };
  const getFirstRev = (lid) => { let m = null; S.revisedDates.filter(rd => rd.loanId === lid && rd.revisedDate).forEach(d => { const dt = parseSheetDate(d.revisedDate); if (dt && (!m || dt < m)) m = dt; }); return m; };
  overdue.sort((a, b) => { const da = getLastRev(a.loanId), db = getLastRev(b.loanId); if (!da && !db) return 0; if (!da) return 1; if (!db) return -1; return db - da; });
  upcoming.sort((a, b) => {
    const da = getLastRev(a.loanId), db = getLastRev(b.loanId);
    if (da && db && da - db !== 0) return da - db;
    if (!da && db) return -1; if (da && !db) return 1;
    const aa = a.nextEmiDate ? parseSheetDate(a.nextEmiDate) : null, bb = b.nextEmiDate ? parseSheetDate(b.nextEmiDate) : null;
    if (aa && bb && bb - aa !== 0) return bb - aa;
    if (!aa && bb) return 1; if (aa && !bb) return -1;
    return (a.customerName||'').localeCompare(b.customerName||'');
  });
  function sectionHtml(label, key, color, bg, icon, items) {
    const collapsed = _ovViewCollapsed[key];
    return `<div class="card" style="margin-bottom:0.5rem;padding:0;overflow:hidden">
      <div onclick="window.__ovToggle('${key}')" style="display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;background:${bg};user-select:none">
        <span style="font-size:14px">${collapsed ? '\u25B6' : '\u25BC'}</span>
        <span style="font-size:12px;font-weight:600;color:${color}">${icon} ${label}</span>
        <span style="font-size:11px;color:#888;margin-left:auto">${items.length}</span>
      </div>
      ${collapsed ? '' : `<div style="padding:6px">${items.map(l => overviewCard(l, label==='Revised (Overdue)'?'overdue':'upcoming')).join('')}</div>`}
    </div>`;
  }
  el.innerHTML = `<div style="font-size:12px;color:#888;margin-bottom:0.5rem">${hasRevDates.length} loan(s) with revised dates</div>`
    + sectionHtml('Revised (Overdue)', 'overdue', '#c62828', '#ffebee', '\uD83D\uDD34', overdue)
    + sectionHtml('Revised (Scheduled)', 'scheduled', '#2e7d32', '#e8f5e9', '\uD83D\uDFE2', upcoming)
    + (mobileJabt.length ? sectionHtml('Mobile Jabt', 'mobile-jabt', '#000', '#f5f5f5', '\uD83D\uDCF1', mobileJabt) : '');
}

function renderOverviewPartials() {
  const el = $('ov-partials-view');
  if (!el) return;
  const q = (($('ov-search') ? $('ov-search').value : '') || '').toLowerCase();
  const pts = S.approvedPartials || [];
  const partialLoanIds = new Set(pts.map(p => p.loanId));
  const source = (S.sheetLoans && S.sheetLoans.length) ? S.sheetLoans : [];
  let loans = source.filter(l => partialLoanIds.has(l.loanId));
  if (q) loans = loans.filter(l => l.loanId.toLowerCase().includes(q) || (l.customerName||'').toLowerCase().includes(q));
  if (!loans.length) {
    el.innerHTML = '<div class="emi-col-empty">No loans with partial payments</div>';
    return;
  }
  el.innerHTML = `<div style="font-size:12px;color:#888;margin-bottom:0.5rem">${loans.length} loan(s) with partial payments</div>
    <div style="display:flex;flex-direction:column;gap:6px">${loans.map(l => overviewCard(l, l.isDefaulted ? 'defaulted' : (l.emiCompleted||l.status==='Closed') ? 'closed' : 'upcoming')).join('')}</div>`;
}

const _ovOverdueCollapsed = {};
window.__ovOverdueToggle = function(key) {
  _ovOverdueCollapsed[key] = !_ovOverdueCollapsed[key];
  renderOverviewOverdue();
};

function renderOverviewOverdue() {
  const el = $('ov-overdue-view');
  if (!el) return;
  const source = (S.sheetLoans && S.sheetLoans.length) ? S.sheetLoans : [];
  const today = new Date(); today.setHours(0,0,0,0);
  const overdue = source.filter(l => {
    if (l.isDefaulted || l.emiCompleted || l.status === 'Closed') return false;
    if (!l.nextEmiDate) return false;
    const due = new Date(l.nextEmiDate); due.setHours(0,0,0,0);
    return due < today;
  });
  const less30 = [], over30 = [], over90 = [];
  overdue.forEach(l => {
    const due = new Date(l.nextEmiDate); due.setHours(0,0,0,0);
    const days = Math.round((today - due) / 86400000);
    if (days > 90) over90.push(l);
    else if (days > 30) over30.push(l);
    else less30.push(l);
  });
  const sortSection = arr => arr.sort((a, b) => {
    const da = new Date(a.nextEmiDate||0), db = new Date(b.nextEmiDate||0);
    return db - da || (a.customerName||'').localeCompare(b.customerName||'');
  });
  sortSection(less30); sortSection(over30); sortSection(over90);

  function sectionHtml(label, key, color, bg, icon, items) {
    const collapsed = _ovOverdueCollapsed[key];
    // Group contiguous items by due date
    let cardHtml = '';
    for (let i = 0; i < items.length; i++) {
      const l = items[i];
      const sameDate = i > 0 && l.nextEmiDate === items[i-1].nextEmiDate;
      const nextEmi = (l.numReceivedEmi || 0) + 1;
      const revDates = (S.revisedDates||[]).filter(rd => rd.loanId === l.loanId && rd.emiNum === nextEmi && rd.revisedDate);
      const revDateStr = revDates.length ? fmtDisplayDate(revDates[revDates.length-1].revisedDate) : '';
      const revPassed = revDates.length && parseSheetDate(revDates[revDates.length-1].revisedDate) < today;
      const revBadge = revDateStr
        ? `<span style="flex:0 0 172px;line-height:14px;text-align:center"><span style="font-size:10px;font-weight:600;color:${color};background:#fff;padding:0 6px;border-radius:8px;white-space:nowrap">${revPassed ? '❌ ' : ''}Rev: ${revDateStr}</span></span>`
        : '<span style="flex:0 0 172px;line-height:14px"></span>';
      const cardIndent = sameDate ? 'margin-left:16px' : '';
      const rightShift = sameDate ? 'margin-left:-16px;' : '';
      cardHtml += `<div class="emi-card overdue" data-loanid="${l.loanId}" style="cursor:pointer;background:${color};border-left:3px solid rgba(255,255,255,0.3);border:1px solid ${color};margin-bottom:4px;padding:8px 10px;${cardIndent}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;height:14px">
          <span style="font-size:11px;font-weight:500;color:#fff;flex:0 0 auto;white-space:nowrap;line-height:14px">${l.nextEmiDate ? fmtDisplayDate(l.nextEmiDate) : '—'}</span>
          <div style="display:flex;flex:1;align-items:center;gap:8px;${rightShift}">
            ${revBadge}
            <span style="font-weight:500;font-size:12px;color:#fff;flex:0 0 auto;line-height:14px">${l.customerName}</span>
            <span style="font-size:11px;color:rgba(255,255,255,0.75);text-align:right;flex:1 1 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:14px">${l.model || ''}</span>
          </div>
        </div>
      </div>`;
    }
    return `<div class="card" style="margin-bottom:0.5rem;padding:0;overflow-x:auto;overflow-y:hidden">
      <div onclick="window.__ovOverdueToggle('${key}')" style="display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;background:${bg};user-select:none">
        <span style="font-size:14px">${collapsed ? '\u25B6' : '\u25BC'}</span>
        <span style="font-size:12px;font-weight:600;color:${color}">${icon} ${label}</span>
        <span style="font-size:11px;color:#888;margin-left:auto">${items.length}</span>
      </div>
      ${collapsed ? '' : `<div style="padding:6px;min-width:max-content">${cardHtml}</div>`}
    </div>`;
  }
  el.innerHTML = `<div style="font-size:12px;color:#888;margin-bottom:0.5rem">${overdue.length} overdue loan(s)</div>`
    + sectionHtml('Less than 30 days', 'less30', '#dd7e6b', '#fdf0ed', '\uD83D\uDD34', less30)
    + sectionHtml('30+ days', 'over30', '#980000', '#fcebeb', '\uD83D\uDD34', over30)
    + sectionHtml('90+ days', 'over90', '#000', '#f0f0f0', '\uD83D\uDD34', over90);
}

async function submitMobileJabt() {
  const loanId = S.selectedEmiLoanId;
  if (!loanId) return;
  if (!confirm('Confirm marking this loan as Mobile Jabt (device seized, no further action)?')) return;
  closeRevisedDateForm();
  showLoader();
  try {
    const res = await gasPost({ action: 'setRevisedDate', loanId, emiNum: 0, revisedDate: '', amount: 0, note: 'Mobile Jabt' });
    if (res.ok) {
      if (res.pending) S.pending = res.pending;
      try {
        const revData = await gasGet('readRevisedDates');
        if (revData.ok) S.revisedDates = revData.dates;
      } catch(e) { console.warn('Could not re-fetch revised dates:', e.message); }
      selectEmiLoan(loanId);
      rerenderActiveTab();
      renderApprovals($('appr-search') ? $('appr-search').value : '');
      showAlert('Loan marked as Mobile Jabt.');
    } else {
      showAlert('Failed to mark Mobile Jabt: ' + (res.error || 'Unknown error'), 'e');
    }
  } finally { hideLoader(); }
}


