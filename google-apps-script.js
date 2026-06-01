/**
 * AKS Financing — Google Apps Script
 * ====================================
 * Handles READ (GET) and WRITE (POST) between the AKS app and your sheet.
 *
 * SETUP STEPS:
 * ─────────────────────────────────────────────────────────────────────────
 * 1. Open your master spreadsheet (the one with the "Data" tab).
 * 2. Go to Extensions → Apps Script.
 * 3. Delete any existing code and paste THIS entire file.
 * 4. Confirm SPREADSHEET_ID below matches your sheet's ID.
 *    (It's the long string in the URL between /d/ and /edit)
 *    Your sheet ID: 10mkkgm0DH6gEFfbgkEvnULEnqdMo1ZmekKWf-iqF6EM
 * 5. Confirm DATA_SHEET_NAME matches your tab name exactly.
 * 6. Click Deploy → New deployment.
 *    - Type: Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 *    Click Deploy and authorise when prompted.
 * 7. Copy the Web App URL → paste into AKS app → Export tab → Save URL.
 */

// ── CONFIGURATION ─────────────────────────────────────────────────────────
const SPREADSHEET_ID  = '10mkkgm0DH6gEFfbgkEvnULEnqdMo1ZmekKWf-iqF6EM';
const DATA_SHEET_NAME = 'Data';

// ── COLUMN MAP (0-based index = column A is 0, B is 1, etc.) ─────────────
// These match your exact column order as provided.
const C = {
  billDate:              0,   // Bill Date
  loanId:                1,   // Loan ID
  customerName:          2,   // Customer Name
  phone:                 3,   // Customer mobile no
  aadhaarPan:            4,   // Customer AADHAR / PAN
  model:                 5,   // Mobile model
  deviceType:            6,   // Device Type
  mobileAmount:          7,   // Mobile amount
  downPayment:           8,   // Down payment
  processingFee:         9,   // Processing Fee
  interest:              10,  // Interest
  emiDuration:           11,  // EMI Duration
  emiStartDate:          12,  // EMI Start Date
  totalAmount:           13,  // Total amount
  totalEmi:              14,  // Total EMI
  monthlyEmi:            15,  // Monthly EMI
  customerId:            16,  // Customer ID
  guarantor:             17,  // Guarantor/ Alternate no/ Comments
  maxInterestDiscount:   18,  // Maximum Interest discount amount
  rateOfInterest:        19,  // Rate of interest
  financeAmount:         20,  // Finance Amount
  appLockCharge:         21,  // App Lock Charge
  akShare:               22,  // AK Share (0.5 = 50%)
  aksShare:              23,  // AKS Share (0.5 = 50%)
  akAmount:              24,  // AK Amount
  akPaidToKunal:         25,  // AK paid to Kunal
  aksAmount:             26,  // AKS Amount
  aksPaidToKunal:        27,  // AKS paid to Kunal
  nextEmiDate:           28,  // Next EMI Date
  lastEmiDate:           29,  // Last EMI Date
  remainingPrincipal:    30,  // Remaining principal amount
  remainingInterest:     31,  // Remaining interest amount
  totalPending:          32,  // Total Pending amount
  receivedPrincipal:     33,  // Received principal amount
  receivedInterest:      34,  // Received Interest Amount
  receivedTotal:         35,  // Received Total amount
  numReceivedEmi:        36,  // Number of received EMI
  emiCompleted:          37,  // EMI completed (YES/NO)
  lateEmis:              38,  // Late EMIs
  latePaymentFine:       39,  // Late Payment Fine
  earlyClosing:          40,  // Early Loan closing settlement
  extraEmiReceived:      41,  // Extra EMI Received
  recoveryCharge:        42,  // Recovery Charge
  welcomeMsg:            43,  // Welcome Message Sent
  closingMsg:            44,  // Loan Closing Message Sent
  lockRemoved:           45,  // Lock app removed
  defaulted:             46,  // Defaulted (TRUE/FALSE checkbox)
  defaultComment:        47,  // Default Comment
  finalRoi:              48,  // Final ROI
  emi1:                  49,  // 1st EMI (checkbox)
  emi2:                  50,  // 2nd EMI (checkbox)
  emi3:                  51,  // 3rd EMI (checkbox)
  emi4:                  52,  // 4th EMI (checkbox)
  emi5:                  53,  // 5th EMI (checkbox)
  emi6:                  54,  // 6th EMI (checkbox)
  emi7:                  55,  // 7th EMI (checkbox)
  emi8:                  56,  // 8th EMI (checkbox)
  emiDate1:              57,  // 1st EMI Date (actual received date)
  emiDate2:              58,  // 2nd EMI Date (actual received date)
  emiDate3:              59,  // 3rd EMI Date (actual received date)
  emiDate4:              60,  // 4th EMI Date (actual received date)
  emiDate5:              61,  // 5th EMI Date (actual received date)
  emiDate6:              62,  // 6th EMI Date (actual received date)
  emiDate7:              63,  // 7th EMI Date (actual received date)
  emiDate8:              64,  // 8th EMI Date (actual received date)
  emiMisc1:              65,  // 1st EMI Misc
  emiMisc2:              66,  // 2nd EMI Misc
  emiMisc3:              67,  // 3rd EMI MIsc
  emiMisc4:              68,  // 4th EMI Misc
  emiMisc5:              69,  // 5th EMI Misc
  emiMisc6:              70,  // 6th EMI Misc
  emiMisc7:              71,  // 7th EMI Misc
  emiMisc8:              72,  // 8th EMI Misc
  cashflow1:             73,  // Cashflow 1
  cashflow2:             74,  // Cashflow 2
  cashflow3:             75,  // Cashflow 3
  cashflow4:             76,  // Cashflow 4
  cashflow5:             77,  // Cashflow 5
  cashflow6:             78,  // Cashflow 6
  cashflow7:             79,  // Cashflow 7
  cashflow8:             80,  // Cashflow 8
  akShareOfEmi:          81,  // AK Share of EMI
  aksShareOfEmi:         82,  // AKS Share of EMI
  driveLink:             83,  // Drive Link
  downPaymentPct:        84,  // Down payment%
  recoveryCharge2:       85,  // Recovery Charge (2nd instance)
  helper1:               86,  // Helper_1
};

// Export tab names
const EXPORT_TABS = ['Loans', 'EMI History', 'Pending Approvals'];

// ── GET — read loans from Data tab ────────────────────────────────────────
function doGet(e) {
  const action = e && e.parameter && e.parameter.action;

  if (action === 'readLoans') {
    try {
      const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
      const sheet = ss.getSheetByName(DATA_SHEET_NAME);
      if (!sheet) return jsonResponse({ ok: false, error: 'Sheet "' + DATA_SHEET_NAME + '" not found.' });

      const lastRow = sheet.getLastRow();
      if (lastRow < 2) return jsonResponse({ ok: true, loans: [] });

      const lastCol = Math.max(Object.values(C).reduce((a, b) => Math.max(a, b), 0) + 1, sheet.getLastColumn());
      const raw     = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues(); // skip header row

      const loans = raw
        .filter(r => r[C.loanId] && String(r[C.loanId]).trim() !== '')
        .map(r => {
          const duration = parseInt(r[C.emiDuration]) || 0;

          // Build per-EMI slot data (up to EMI Duration)
          // emiDate columns now hold ACTUAL received dates (not scheduled dates).
          // Scheduled due date is calculated from EMI start date + (N-1) months.
          const emiStartRaw = r[C.emiStartDate];
          const emiStartDate = (emiStartRaw instanceof Date && !isNaN(emiStartRaw)) ? emiStartRaw : null;

          const emiKeys  = [C.emi1,C.emi2,C.emi3,C.emi4,C.emi5,C.emi6,C.emi7,C.emi8];
          const dateKeys = [C.emiDate1,C.emiDate2,C.emiDate3,C.emiDate4,C.emiDate5,C.emiDate6,C.emiDate7,C.emiDate8];
          const miscKeys = [C.emiMisc1,C.emiMisc2,C.emiMisc3,C.emiMisc4,C.emiMisc5,C.emiMisc6,C.emiMisc7,C.emiMisc8];
          const cashKeys = [C.cashflow1,C.cashflow2,C.cashflow3,C.cashflow4,C.cashflow5,C.cashflow6,C.cashflow7,C.cashflow8];

          const slots = [];
          for (let i = 0; i < Math.min(duration, 8); i++) {
            // Scheduled due date = EMI start date + i months
            let scheduledDate = '';
            if (emiStartDate) {
              const d = new Date(emiStartDate);
              d.setMonth(d.getMonth() + i);
              scheduledDate = fmtDate(d);
            }
            slots.push({
              num:          i + 1,
              received:     r[emiKeys[i]]  === true,         // checkbox TRUE/FALSE
              scheduledDate,                                  // calculated due date
              receivedDate: fmtDate(r[dateKeys[i]]),         // actual received date
              misc:         parseFloat(r[miscKeys[i]])  || 0,
              cashflow:     parseFloat(r[cashKeys[i]])  || 0,
            });
          }

          const isDefaulted   = r[C.defaulted] === true;
          const emiCompleted  = String(r[C.emiCompleted] || '').trim().toUpperCase() === 'YES';
          const nextEmiDate   = fmtDate(r[C.nextEmiDate]);

          // Categorise: closed = EMI completed YES; defaulted = checkbox TRUE; else active
          let status = 'Active';
          if (emiCompleted)  status = 'Closed';
          if (isDefaulted)   status = 'Defaulted';

          return {
            loanId:            String(r[C.loanId]).trim(),
            billDate:          fmtDate(r[C.billDate]),
            customerName:      String(r[C.customerName] || '').trim(),
            phone:             String(r[C.phone]        || '').trim(),
            aadhaarPan:        String(r[C.aadhaarPan]   || '').trim(),
            model:             String(r[C.model]        || '').trim(),
            deviceType:        String(r[C.deviceType]   || '').trim(),
            mobileAmount:      parseFloat(r[C.mobileAmount])   || 0,
            downPayment:       parseFloat(r[C.downPayment])    || 0,
            processingFee:     parseFloat(r[C.processingFee])  || 0,
            interest:          parseFloat(r[C.interest])       || 0,
            emiDuration:       duration,
            emiStartDate:      fmtDate(r[C.emiStartDate]),
            totalAmount:       parseFloat(r[C.totalAmount])    || 0,
            monthlyEmi:        parseFloat(r[C.monthlyEmi])     || 0,
            financeAmount:     parseFloat(r[C.financeAmount])  || 0,
            appLockCharge:     parseFloat(r[C.appLockCharge])  || 0,
            akShare:           parseFloat(r[C.akShare])        || 0,  // 0–1 decimal
            aksShare:          parseFloat(r[C.aksShare])       || 0,
            akAmount:          parseFloat(r[C.akAmount])       || 0,
            aksAmount:         parseFloat(r[C.aksAmount])      || 0,
            guarantor:         String(r[C.guarantor]          || '').trim(),
            customerId:        String(r[C.customerId]         || '').trim(),
            nextEmiDate,
            lastEmiDate:       fmtDate(r[C.lastEmiDate]),
            remainingPrincipal:parseFloat(r[C.remainingPrincipal]) || 0,
            remainingInterest: parseFloat(r[C.remainingInterest])  || 0,
            totalPending:      parseFloat(r[C.totalPending])       || 0,
            receivedTotal:     parseFloat(r[C.receivedTotal])      || 0,
            numReceivedEmi:    parseInt(r[C.numReceivedEmi])       || 0,
            lateEmis:          parseInt(r[C.lateEmis])             || 0,
            latePaymentFine:   parseFloat(r[C.latePaymentFine])    || 0,
            extraEmiReceived:  parseFloat(r[C.extraEmiReceived])   || 0,
            earlyClosing:      parseFloat(r[C.earlyClosing])       || 0,
            recoveryCharge:    parseFloat(r[C.recoveryCharge])     || 0,
            akPaidToKunal:     parseFloat(r[C.akPaidToKunal])      || 0,
            aksPaidToKunal:    parseFloat(r[C.aksPaidToKunal])     || 0,
            akShareOfEmi:      parseFloat(r[C.akShareOfEmi])       || 0,
            aksShareOfEmi:     parseFloat(r[C.aksShareOfEmi])      || 0,
            receivedPrincipal: parseFloat(r[C.receivedPrincipal])  || 0,
            receivedInterest:  parseFloat(r[C.receivedInterest])   || 0,
            interest:          parseFloat(r[C.interest])           || 0,
            appLockCharge:     parseFloat(r[C.appLockCharge])      || 0,
            rateOfInterest:    parseFloat(r[C.rateOfInterest])     || 0,
            finalRoi:          parseFloat(r[C.finalRoi])           || 0,
            welcomeMsg:        r[C.welcomeMsg]  === true,
            closingMsg:        r[C.closingMsg]  === true,
            lockRemoved:       r[C.lockRemoved] === true,
            driveLink:          String(r[C.driveLink]          || '').trim(),
            customerId:         String(r[C.customerId]         || '').trim(),
            maxInterestDiscount:parseFloat(r[C.maxInterestDiscount])  || 0,
            totalEmi:           parseInt(r[C.totalEmi])               || 0,
            downPaymentPct:     parseFloat(r[C.downPaymentPct])       || 0,
            defaultComment:    String(r[C.defaultComment] || '').trim(),
            status,
            isDefaulted,
            emiCompleted,
            slots,             // per-EMI slot details
          };
        });

      return jsonResponse({ ok: true, loans });

    } catch (err) {
      return jsonResponse({ ok: false, error: err.message });
    }
  }

  // Health check
  return jsonResponse({ ok: true, message: 'AKS Financing Apps Script is running.' });
}

// ── POST — write export data to tabs ─────────────────────────────────────
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const { tab, headers, rows } = payload;

    if (!EXPORT_TABS.includes(tab)) {
      return jsonResponse({ ok: false, error: 'Unknown tab: ' + tab });
    }

    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    let sheet = ss.getSheetByName(tab);
    if (!sheet) sheet = ss.insertSheet(tab);

    sheet.clearContents();
    const allRows = [headers, ...rows];
    sheet.getRange(1, 1, allRows.length, allRows[0].length).setValues(allRows);

    const hdr = sheet.getRange(1, 1, 1, headers.length);
    hdr.setFontWeight('bold');
    hdr.setBackground('#534AB7');
    hdr.setFontColor('#ffffff');
    sheet.autoResizeColumns(1, headers.length);

    return jsonResponse({ ok: true, tab, rowCount: rows.length });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtDate(val) {
  if (!val) return '';
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (val instanceof Date && !isNaN(val)) {
    const yy = String(val.getFullYear()).slice(-2);
    return val.getDate() + '-' + MONTHS[val.getMonth()] + '-' + yy;
  }
  // Already a string — return as-is (sheet may already format it)
  return String(val).trim();
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
