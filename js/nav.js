// ── NAV ───────────────────────────────────────────────────────────────────

// Tab definitions with icons for bottom nav
const TAB_ICONS = {
  'new-loan':        { icon: '➕', label: 'New Loan' },
  'emi':             { icon: '💰', label: 'Log EMI' },
  'my-subs':         { icon: '📋', label: 'My Subs' },
  'approvals':       { icon: '✅', label: 'Approvals' },
  'all-loans':       { icon: '📊', label: 'All Loans' },
  'emi-hist':        { icon: '🕐', label: 'History' },
  'users':           { icon: '👥', label: 'Users' },
  'export':          { icon: '⬆', label: 'Export' },
};

function buildNav() {
  const u  = S.cu;
  const pc = S.pending.filter(x => x.status === 'pending').length;
  let tabs = [];
  if (u.perms.loan) tabs.push({ id: 'new-loan',   label: 'New loan' });
  if (u.perms.emi)  tabs.push({ id: 'emi',         label: 'Log EMI' });
  if (u.role === 'agent') tabs.push({ id: 'my-subs', label: 'My submissions' });
  if (u.role === 'admin') {
    tabs.push({ id: 'approvals', label: 'Approvals', badge: pc });
    tabs.push({ id: 'all-loans', label: 'All Loans' });
    tabs.push({ id: 'emi-hist',  label: 'EMI history' });
    tabs.push({ id: 'users',     label: 'Users' });
    tabs.push({ id: 'export',    label: '⬆ Export' });
  }

  // Desktop top nav
  $('nav').innerHTML = tabs.map(t =>
    `<button class="nav-btn" id="nav-${t.id}" onclick="goTo('${t.id}')">${t.label}${t.badge ? `<span class="pcount">${t.badge}</span>` : ''}</button>`
  ).join('');

  // Mobile bottom nav
  const bn = $('bottom-nav');
  if (bn) {
    bn.innerHTML = tabs.map(t => {
      const ti = TAB_ICONS[t.id] || { icon: '•', label: t.label };
      const badgeHtml = t.badge ? `<span class="bnav-badge">${t.badge}</span>` : '';
      return `<button class="bnav-btn" id="bnav-${t.id}" onclick="goTo('${t.id}')">
        <span class="bnav-icon">${ti.icon}${badgeHtml}</span>
        <span>${ti.label}</span>
      </button>`;
    }).join('');
    bn.style.display = 'flex';
  }
}

function goTo(pg) {
  S.page = pg;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.bnav-btn').forEach(b => b.classList.remove('active'));
  const el = $('page-' + pg); if (el) el.classList.add('active');
  const nb = $('nav-'  + pg); if (nb) nb.classList.add('active');
  const bb = $('bnav-' + pg); if (bb) bb.classList.add('active');
  $('alert-box').innerHTML = '';
  if (pg === 'new-loan')  initNewLoanPage();
  if (pg === 'emi')       { populateEmiSelect(); mobSwitchEmiCol('upcoming'); }
  if (pg === 'my-subs')   renderMySubs();
  if (pg === 'approvals') renderApprovals();
  if (pg === 'all-loans') { renderClosedDefaulted(''); mobSwitchCdCol('running'); }
  if (pg === 'emi-hist')  renderEmiHist();
  if (pg === 'users')     renderUsers();
  if (pg === 'export')    renderExportPage();
}

function refreshNav() { buildNav(); }

// ── Mobile column switchers ───────────────────────────────────────────────
function mobSwitchEmiCol(col) {
  // Show/hide columns
  ['upcoming','overdue'].forEach(c => {
    const wrap = $('emi-col-' + c);
    const tab  = $('mob-tab-' + c);
    if (!wrap || !tab) return;
    const active = c === col;
    wrap.classList.toggle('mob-active', active);
    tab.classList.toggle('active', active);
  });
  // Sync counts to mobile tab labels
  const uc = $('col-upcoming-count'), oc = $('col-overdue-count');
  const muc = $('mob-upcoming-count'), moc = $('mob-overdue-count');
  if (uc && muc) muc.textContent = uc.textContent;
  if (oc && moc) moc.textContent = oc.textContent;
}

function mobSwitchCdCol(col) {
  ['running','closed','defaulted'].forEach(c => {
    const wrap = $('cd-col-' + c);
    const tab  = $('mob-tab-' + c);
    if (!wrap || !tab) return;
    const active = c === col;
    wrap.classList.toggle('mob-active', active);
    tab.classList.toggle('active', active);
  });
}
