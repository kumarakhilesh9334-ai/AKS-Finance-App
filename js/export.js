// ── EXPORT ────────────────────────────────────────────────────────────────
// Sends data to Google Sheets via a Google Apps Script Web App.
// Each section (Loans, EMIs, Pending) goes to its own sheet tab.

// ── Save/load the Web App URL ─────────────────────────────────────────────
function saveSheetUrl() {
  const url = v('sheets-url-input').trim();
  if (!url.startsWith('https://script.google.com')) {
    setExportStatus('Please paste a valid Google Apps Script URL.', 'err');
    return;
  }
  S.sheetsUrl = url;
  localStorage.setItem('aks_sheets_url', url);
  setExportStatus('URL saved ✓ — fetching loans now…', 'ok');
  // Immediately pull loans so the EMI tab is ready
  fetchLoansFromSheets().then(() => {
    setExportStatus('URL saved ✓ — loans loaded. Go to Log EMI tab.', 'ok');
  });
}

function renderExportPage() {
  $('sheets-url-input').value = S.sheetsUrl || '';
  setExportStatus('', '');
}

function setExportStatus(msg, type) {
  const el = $('export-status');
  el.textContent = msg;
  el.className = 'export-status' + (type ? ' ' + type : '');
}

// ── Core export function ──────────────────────────────────────────────────
async function exportToSheets(tab) {
  if (!S.sheetsUrl) {
    setExportStatus('Please save your Google Apps Script URL first.', 'err');
    return;
  }

  let rows = [];
  let headers = [];

  if (tab === 'Loans') {
    headers = ['Loan ID','Bill Date','Customer Name','Phone','Aadhaar/PAN','Model','Device Type',
      'Device Price','Down Payment','Processing Fee','App Lock Charge','Interest',
      'Finance Amount','Total Amount','Monthly EMI','Tenure','EMI Start',
      'AK Share %','AKS Share %','AK Amount','AKS Amount','Guarantor',
      'EMIs Paid','Status','Approved At'];
    rows = S.loans.map(l => {
      const d = l.data;
      return [
        l.loanId, d.billDate, d.customerName, d.phone, d.idNum, d.model, d.deviceType,
        d.price, d.downPayment, d.processingFee, d.appLockCharge, d.interest,
        d.financeAmount, d.totalAmount, d.monthlyEmi, d.tenure, d.emiStart,
        d.akShare, d.aksShare, d.akAmount, d.aksAmount, d.guarantor || '',
        l.emis.length, l.closed ? 'Closed' : 'Active', l.approvedAt,
      ];
    });
  } else if (tab === 'EMI History') {
    headers = ['Loan ID','Customer Name','Model','EMI Number','Expected Amount','Received Amount',
      'Difference','Payment Date','Mode','Reason','Notes','AK Share %','AKS Share %','Approved At'];
    rows = S.emis.map(e => [
      e.loanId, e.customerName, e.model, e.emiNum, e.expectedAmount, e.amount,
      e.amount - e.expectedAmount, e.date, e.mode, e.reason || '', e.notes || '',
      e.akShare, e.aksShare, e.approvedAt,
    ]);
  } else if (tab === 'Pending Approvals') {
    headers = ['ID','Type','Status','Submitted By','Submitted At','Loan ID','Customer','Details','Rejection Note'];
    rows = S.pending.map(p => {
      const user = S.users.find(u => u.id === p.submittedBy);
      const detail = p.type === 'loan'
        ? `Model: ${p.data.model}, EMI: ₹${p.data.monthlyEmi}, Tenure: ${p.data.tenure}m`
        : `EMI ${p.data.emiNum}, Received: ₹${p.data.amount}`;
      return [
        p.id, p.type, p.status, user?.name || 'Unknown', p.submittedAt,
        p.data.loanId, p.data.customerName, detail, p.note || '',
      ];
    });
  }

  if (!rows.length) {
    setExportStatus(`No data to export for "${tab}".`, 'err');
    return;
  }

  setExportStatus(`Exporting ${rows.length} rows to "${tab}" tab…`, 'loading');

  try {
    const payload = { tab, headers, rows };
    const res = await fetch(S.sheetsUrl, {
      method: 'POST',
      mode: 'no-cors', // Apps Script doesn't allow CORS from unknown origins
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    });
    // no-cors means we can't read the response, but if it didn't throw it was sent
    setExportStatus(`✓ Data sent to "${tab}" tab in Google Sheets.`, 'ok');
  } catch (err) {
    setExportStatus('Export failed: ' + err.message, 'err');
  }
}

async function exportAll() {
  for (const tab of ['Loans', 'EMI History', 'Pending Approvals']) {
    await exportToSheets(tab);
    await new Promise(r => setTimeout(r, 600)); // small delay between tabs
  }
  setExportStatus('✓ All tabs exported to Google Sheets.', 'ok');
}
