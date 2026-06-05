// ── LOANS ─────────────────────────────────────────────────────────────────

// ── RATE() — mirrors Excel/Sheets RATE(nper, pmt, pv)*12 ─────────────────
// nper=duration, pmt=monthlyEmi, pv=-financeAmount (device-down+applock)
function computeRATE(nper, pmt, pv) {
  if (!nper || !pmt || !pv) return 0;
  let rate = 0.01;
  for (let i = 0; i < 300; i++) {
    const pow    = Math.pow(1 + rate, nper);
    const f      = pv * pow + pmt * (pow - 1) / rate;
    const fPrime = pv * nper * Math.pow(1 + rate, nper - 1)
                 + pmt * (nper * rate * Math.pow(1 + rate, nper - 1) - (pow - 1)) / (rate * rate);
    if (!fPrime) break;
    const delta = f / fPrime;
    rate -= delta;
    if (Math.abs(delta) < 1e-12) break;
  }
  return (isNaN(rate) || !isFinite(rate) || rate < 0) ? 0 : rate;
}

// ── Page init ─────────────────────────────────────────────────────────────
function initNewLoanPage() {
  const today = new Date().toISOString().split('T')[0];
  $('f-billdate').value    = today;
  $('f-pfee').value        = 399;
  $('f-monthly-emi').value = '';
  $('f-int').value         = '';
  $('f-akshare').value     = '0';
  $('f-applock').value     = 299;
  $('calc-preview').style.display         = 'none';
  $('customer-loans-panel').style.display = 'none';
  $('idnum-dropdown').style.display       = 'none';
  $('emistart-err').style.display         = 'none';
  setTimeout(validateLoanForm, 0);
}

function validateLoanForm() {
  const requiredFields = ['f-idnum', 'f-cname', 'f-phone', 'f-billdate', 'f-model', 'f-dtype', 'f-price', 
  'f-down', 'f-pfee', 'f-applock', 'f-tenure', 'f-monthly-emi', 'f-emistart', 'f-akshare'];

  let valid = true;

  requiredFields.forEach(id => {
    const el = $(id);

    if (!el || String(el.value).trim() === '') {
      valid = false;
    }
  });

  // Custom AK share must be filled if selected
  if (v('f-akshare') === 'custom') {
    const customVal = num('f-akcustom');
    if (customVal < 0 || customVal > 100) valid = false;
  }

  const btn = $('loan-submit-btn');

  if (valid) {
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
  } else {
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'not-allowed';
  }
}


// ── Aadhaar/PAN autocomplete ──────────────────────────────────────────────
function onIdNumInput() {
  const q  = v('f-idnum').toLowerCase().replace(/\s/g, '');
  const dd = $('idnum-dropdown');
  if (q.length < 4) { dd.style.display = 'none'; return; }
  const seen = {};
  (S.sheetLoans || []).forEach(l => {
    const id = (l.aadhaarPan || '').toLowerCase().replace(/\s/g, '');
    if (id.includes(q) && !seen[id]) seen[id] = l;
  });
  const matches = Object.values(seen).slice(0, 6);
  if (!matches.length) { dd.style.display = 'none'; return; }
  dd.innerHTML = matches.map(l =>
    `<div class="idnum-option" onclick="selectCustomer('${l.aadhaarPan.replace(/'/g,"\\'")}')">
      <span style="font-weight:500">${l.customerName}</span>
      <span style="color:#888;font-size:11px;margin-left:8px">${l.aadhaarPan}</span>
    </div>`
  ).join('');
  dd.style.display = 'block';
}

function selectCustomer(aadhaarPan) {
  $('idnum-dropdown').style.display = 'none';
  $('f-idnum').value = aadhaarPan;
  const all = (S.sheetLoans || []).filter(l =>
    (l.aadhaarPan || '').toLowerCase().replace(/\s/g,'') ===
    aadhaarPan.toLowerCase().replace(/\s/g,'')
  );
  if (!all.length) return;
  $('f-cname').value = all[0].customerName || ''; // name only
  renderCustomerLoansPanel(all);
  genLoanId();
}

function renderCustomerLoansPanel(loans) {
  const panel = $('customer-loans-panel');
  if (!loans.length) { panel.style.display = 'none'; return; }
  const today = new Date(); today.setHours(0,0,0,0);
  const defaulted = [], overdue = [], upcoming = [], closed = [];
  loans.forEach(l => {
    if (l.isDefaulted) { defaulted.push(l); return; }
    if (l.emiCompleted || l.status === 'Closed') { closed.push(l); return; }
    if (!l.nextEmiDate) { upcoming.push(l); return; }
    const due = new Date(l.nextEmiDate); due.setHours(0,0,0,0);
    if (due < today) overdue.push(l); else upcoming.push(l);
  });
  const colorMap = { defaulted:'#BA7517',overdue:'#A32D2D',upcoming:'#0F6E56',closed:'#888' };
  const bgMap    = { defaulted:'#FAEEDA',overdue:'#FCEBEB',upcoming:'#E1F5EE',closed:'#F1EFE8' };
  const renderGroup = (items, type, label) => !items.length ? '' :
    `<div style="margin-bottom:6px">
      <div style="font-size:10px;font-weight:600;color:${colorMap[type]};text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">${label}</div>
      ${items.map(l=>`<div class="cust-loan-pill" style="border-left:3px solid ${colorMap[type]};background:${bgMap[type]}">
        <span style="font-weight:500;font-size:12px">${l.loanId}</span>
        <span style="font-size:11px;color:#666;margin-left:6px">${lFmt(l.monthlyEmi)}/mo</span>
        ${l.nextEmiDate?`<span style="font-size:10px;color:${colorMap[type]};margin-left:auto">${fmtD2(l.nextEmiDate)}</span>`:''}
      </div>`).join('')}
    </div>`;
  panel.innerHTML =
    `<div style="font-size:11px;font-weight:600;color:#534AB7;margin-bottom:8px;text-transform:uppercase;letter-spacing:.4px">Existing loans</div>` +
    renderGroup(defaulted,'defaulted','⚠️ Defaulted') +
    renderGroup(overdue,  'overdue',  '🔴 Overdue') +
    renderGroup(upcoming, 'upcoming', '🟢 Upcoming') +
    renderGroup(closed,   'closed',   '⚪ Closed');
  panel.style.display = 'block';
}

document.addEventListener('click', e => {
  if (!e.target.closest('#idnum-wrap')) $('idnum-dropdown').style.display = 'none';
});

// ── Device type → app lock default ───────────────────────────────────────
function onDeviceTypeChange() {
  $('f-applock').value = ($('f-dtype').value === 'Mobile') ? 299 : 0;
  calcLoan();
}

// ── EMI start: snap to 5,10,15,20,25 ─────────────────────────────────────
function onEmiStartChange() {
  const val = $('f-emistart').value; if (!val) return;
  const [y, m, d] = val.split('-');
  const day = parseInt(d);
  const allowed = [5,10,15,20,25];
  if (!allowed.includes(day)) {
    const nearest = allowed.reduce((p,c) => Math.abs(c-day)<Math.abs(p-day)?c:p);
    $('f-emistart').value = `${y}-${m}-${String(nearest).padStart(2,'0')}`;
    $('emistart-err').textContent = `Adjusted to ${nearest} — only 5, 10, 15, 20, 25 allowed.`;
    $('emistart-err').style.display = 'block';
    setTimeout(() => $('emistart-err').style.display = 'none', 3000);
  } else {
    $('emistart-err').style.display = 'none';
  }
}

// ── Loan ID ───────────────────────────────────────────────────────────────
function genLoanId() {
  const name = v('f-cname').split(' ')[0];
  const id   = v('f-idnum').replace(/\s/g,'');
  if (!name || id.length < 4) { $('cp-loanid').textContent = '—'; return; }
  const last4 = id.slice(-4);
  const base  = name + last4;
  const existing =
    S.loans.filter(l => l.loanId.startsWith(base)).length +
    S.pending.filter(p => p.type==='loan' && p.data.loanId && p.data.loanId.startsWith(base)).length;
  const lid = base + '/' + (existing + 1);
  $('cp-loanid').textContent = lid;
  return lid;
}

// ── Calc: user types Monthly EMI → everything auto-computes ──────────────
function calcLoan() {
  const price      = num('f-price');
  const down       = num('f-down');
  const pfee       = num('f-pfee');
  const applock    = num('f-applock');
  const tenure     = num('f-tenure');
  const monthlyEmi = num('f-monthly-emi');
  const akSel      = v('f-akshare');

  $('ak-custom-wrap').style.display = akSel === 'custom' ? 'block' : 'none';
  const akPct  = akSel==='custom'?num('f-akcustom'):(akSel==='0'?0:akSel==='100'?100:akSel==='50'?50:0);
  const aksPct = 100 - akPct;

  // Interest = EMI×duration − (device−down) − processingFee
  let interest = 0;
  if (monthlyEmi && tenure && price) {
    interest = monthlyEmi * tenure - (price - down) - pfee;
    if (interest < 0) interest = 0;
  }
  $('f-int').value = interest ? Math.round(interest) : '';

  // Finance amount for RATE = device − down + applock  (owed to shopkeeper)
  const financeAmount = price - down + applock;
  const totalAmount   = financeAmount + pfee + interest;

  // ROI = RATE(duration, monthlyEmi, −financeAmount) × 12 × 100  → annual %
  let roi = 0;
  if (tenure && monthlyEmi && financeAmount > 0) {
    const monthlyRate = computeRATE(tenure, monthlyEmi, -financeAmount);
    roi = monthlyRate * 12 * 100;
  }

  const akAmt  = Math.round(financeAmount * akPct  / 100);
  const aksAmt = Math.round(financeAmount * aksPct / 100);

  if (price || monthlyEmi) {
    $('calc-preview').style.display = 'block';
    $('cp-finance').textContent  = lFmt(financeAmount);
    $('cp-total').textContent    = lFmt(totalAmount);
    $('cp-emi').textContent      = monthlyEmi ? lFmt(monthlyEmi) : '—';
    $('cp-interest').textContent = interest   ? lFmt(Math.round(interest)) : '—';
    $('cp-roi').textContent      = roi > 0    ? roi.toFixed(2) + '% p.a.' : '—';
    $('cp-ak').textContent       = lFmt(akAmt)  + ` (${akPct}%)`;
    $('cp-aks').textContent      = lFmt(aksAmt) + ` (${aksPct}%)`;
  } else {
    $('calc-preview').style.display = 'none';
  }
  genLoanId();
}

// ── Submit ────────────────────────────────────────────────────────────────
function submitLoan() {
  const cname      = v('f-cname'), idnum = v('f-idnum'), phone = v('f-phone');
  const model      = v('f-model');
  const tenure     = num('f-tenure'), price = num('f-price'), monthlyEmi = num('f-monthly-emi');
  // if (!cname||!idnum||!phone||!model||!tenure||!price||!monthlyEmi) {
  //  showAlert('Please fill in all required fields including Monthly EMI.','e'); return;}
  if (
  !v('f-idnum') ||
  !v('f-cname') ||
  !v('f-phone') ||
  !v('f-billdate') ||
  !v('f-model') ||
  !v('f-dtype') ||
  !num('f-price') ||
  num('f-down') === null ||
  !num('f-pfee') ||
  !num('f-applock') &&
  num('f-applock') !== 0 ||
  !num('f-tenure') ||
  !num('f-monthly-emi') ||
  !v('f-emistart') ||
  !v('f-akshare')
) {
  showAlert('Please complete all mandatory fields.','e');
  return;
}
  const emiStartVal = v('f-emistart');
  if (emiStartVal && ![5,10,15,20,25].includes(parseInt(emiStartVal.split('-')[2]))) {
    showAlert('EMI start date must be on 5, 10, 15, 20 or 25.','e'); return;
  }
  const last4 = idnum.replace(/\s/g,'').slice(-4);
  const base  = cname.split(' ')[0] + last4;
  const existing =
    S.loans.filter(l=>l.loanId.startsWith(base)).length +
    S.pending.filter(p=>p.type==='loan'&&p.status!=='rejected'&&p.data.loanId&&p.data.loanId.startsWith(base)).length;
  const loanId = base + '/' + (existing + 1);

  const akSel  = v('f-akshare');
  const akPct  = akSel==='custom'?num('f-akcustom'):(akSel==='0'?0:akSel==='100'?100:akSel==='50'?50:0);
  const aksPct = 100 - akPct;
  const down   = num('f-down'), pfee = num('f-pfee'), applock = num('f-applock');
  const interest     = Math.max(0, monthlyEmi*tenure - (price-down) - pfee);
  const financeAmount= price - down + applock;
  const totalAmount  = financeAmount + pfee + interest;
  const roi          = financeAmount>0 ? computeRATE(tenure,monthlyEmi,-financeAmount)*12*100 : 0;

  const d = {
    loanId, billDate:v('f-billdate'), customerName:cname, phone, idNum:idnum,
    model:v('f-model'), deviceType:v('f-dtype'), price, downPayment:down,
    processingFee:pfee, appLockCharge:applock, interest:Math.round(interest),
    rateOfInterest:parseFloat(roi.toFixed(2)), tenure, emiStart:emiStartVal,
    guarantor:v('f-guar'), akShare:akPct, aksShare:aksPct,
    financeAmount, totalAmount, monthlyEmi,
    akAmount:Math.round(financeAmount*akPct/100),
    aksAmount:Math.round(financeAmount*aksPct/100), emis:[],
  };
  const loanItem = {id:nextPid(),type:'loan',data:d,submittedBy:S.cu.id,submittedAt:new Date().toISOString(),status:'pending',note:''};
  S.pending.push(loanItem);
  resetLoanForm();
  showAlert('Loan submitted for approval.');
  refreshNav();
  // Persist to Unapproved_Loan sheet
  if (S.sheetsUrl) gasPost({action:'saveLoan', item:loanItem});
}

// ── Reset ─────────────────────────────────────────────────────────────────
function resetLoanForm() {
  ['f-cname','f-phone','f-idnum','f-guar','f-model','f-price','f-down',
   'f-tenure','f-akcustom','f-monthly-emi','f-int']
    .forEach(id => { const el=$(id); if(el) el.value=''; });
  $('f-dtype').selectedIndex = 0;
  initNewLoanPage();
}

// ── Helpers ───────────────────────────────────────────────────────────────
function lFmt(n)   { return (n==null||n==='') ? '—' : '₹'+Number(n).toLocaleString('en-IN'); }
function fmtD2(d)  { if(!d) return '—'; const dt=new Date(d); return isNaN(dt)?String(d):dt.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }

document.addEventListener('input', e => {
  if (
    e.target.id &&
    e.target.id.startsWith('f-')
  ) {
    validateLoanForm();
  }
});

document.addEventListener('change', e => {
  if (
    e.target.id &&
    e.target.id.startsWith('f-')
  ) {
    validateLoanForm();
  }
});