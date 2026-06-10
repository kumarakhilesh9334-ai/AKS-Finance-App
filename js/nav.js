// ── NAV ───────────────────────────────────────────────────────────────────

// Tab definitions with icons for bottom nav
const TAB_ICONS = {
  'new-loan':        { icon: '➕', label: 'New Loan' },
  'emi':             { icon: '💰', label: 'Log EMI' },
  'approvals':       { icon: '✅', label: 'Approvals' },
  'all-loans':       { icon: '📊', label: 'All Loans' },
  'my-subs':         { icon: '📝', label: 'My Subs' },
  'users':           { icon: '👥', label: 'Users' },
  'emi-msgs':        { icon: '📱', label: 'EMI Msgs' },
};

function buildNav() {
  const u  = S.cu;
  const pc = S.pending.filter(x => x.status === 'pending').length;
  let tabs = [];
  if (u.perms.loan)      tabs.push({ id: 'new-loan',   label: 'New loan' });
  if (u.perms.emi)       tabs.push({ id: 'emi',         label: 'Log EMI' });
  const myCount = S.pending.filter(x => x.status === 'pending' && x.submittedBy === u.id).length;
  if (u.role === 'admin' || u.perms.loan || u.perms.emi)
    tabs.push({ id: 'my-subs', label: 'My Subs', badge: myCount||null });
  if (u.role === 'admin' || u.perms.approvals) tabs.push({ id: 'approvals', label: 'Approvals', badge: pc });
  if (u.role === 'admin' || u.perms.allLoans)  tabs.push({ id: 'all-loans', label: 'All Loans' });
  if (u.role === 'admin') tabs.push({ id: 'emi-msgs', label: 'EMI Msgs' });
  if (u.role === 'admin') tabs.push({ id: 'users', label: 'Users' });

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
  if (pg === 'approvals') { renderApprovals($('appr-search') ? $('appr-search').value : ''); mobSwitchApprCol('loan'); }
  if (pg === 'all-loans') { renderClosedDefaulted(''); mobSwitchCdCol('running'); }
  if (pg === 'my-subs')   renderMySubs();
  if (pg === 'emi-msgs')  initEmiMsgsPage();
  if (pg === 'users')     renderUsers();
}

function refreshNav() { buildNav(); }

// ── Mobile column switchers ───────────────────────────────────────────────
function mobSwitchEmiCol(col) {
  // Show/hide columns
  ['upcoming','overdue','partials'].forEach(c => {
    const wrap = $('emi-col-' + c);
    const tab  = $('mob-tab-' + c);
    if (!wrap || !tab) return;
    const active = c === col;
    wrap.classList.toggle('mob-active', active);
    tab.classList.toggle('active', active);
  });
  // Sync counts to mobile tab labels
  ['upcoming','overdue','partials'].forEach(c => {
    const colEl = $('col-' + c + '-count');
    const mobEl = $('mob-' + c + '-count');
    if (colEl && mobEl) mobEl.textContent = colEl.textContent;
  });
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

function mobSwitchApprCol(col) {
  ['loan','emi'].forEach(c => {
    const wrap = $('appr-col-' + c);
    const tab  = $('mob-tab-' + c);
    if (!wrap || !tab) return;
    const active = c === col;
    wrap.classList.toggle('mob-active', active);
    tab.classList.toggle('active', active);
  });
  // Sync counts
  const lc = $('appr-loan-count'), ec = $('appr-emi-count');
  const mlc = $('mob-appr-loan-count'), mec = $('mob-appr-emi-count');
  if (lc && mlc) mlc.textContent = lc.textContent;
  if (ec && mec) mec.textContent = ec.textContent;
}
