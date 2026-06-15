/**
 * AKS Finance — Google Apps Script
 * Sheets: Data | Unapproved_Loan | Unapproved_EMI | Input | logged EMI
 */

const SPREADSHEET_ID   = '10mkkgm0DH6gEFfbgkEvnULEnqdMo1ZmekKWf-iqF6EM';
const DATA_SHEET       = 'Data';
const UNAPP_LOAN_SHEET = 'Unapproved_Loan';
const UNAPP_EMI_SHEET  = 'Unapproved_EMI';
const INPUT_SHEET      = 'Input';
const LOGGED_EMI_SHEET     = 'logged EMI';
const USERS_SHEET          = 'Users';
const REVISED_DATES_SHEET  = 'Revised_Dates';

// Column map for Data tab (0-based, column A = 0)
const C = {
  billDate:0,loanId:1,customerName:2,phone:3,aadhaarPan:4,model:5,deviceType:6,
  mobileAmount:7,downPayment:8,processingFee:9,interest:10,emiDuration:11,
  emiStartDate:12,totalAmount:13,totalEmi:14,monthlyEmi:15,customerId:16,
  guarantor:17,maxInterestDiscount:18,rateOfInterest:19,financeAmount:20,
  appLockCharge:21,akShare:22,aksShare:23,akAmount:24,akPaidToKunal:25,
  aksAmount:26,aksPaidToKunal:27,nextEmiDate:28,lastEmiDate:29,
  remainingPrincipal:30,remainingInterest:31,totalPending:32,
  receivedPrincipal:33,receivedInterest:34,receivedTotal:35,
  numReceivedEmi:36,emiCompleted:37,lateEmis:38,latePaymentFine:39,
  earlyClosing:40,extraEmiReceived:41,recoveryCharge:42,welcomeMsg:43,
  closingMsg:44,lockRemoved:45,defaulted:46,defaultComment:47,finalRoi:48,
  emi1:49,emi2:50,emi3:51,emi4:52,emi5:53,emi6:54,emi7:55,emi8:56,
  emiDate1:57,emiDate2:58,emiDate3:59,emiDate4:60,emiDate5:61,emiDate6:62,
  emiDate7:63,emiDate8:64,emiMisc1:65,emiMisc2:66,emiMisc3:67,emiMisc4:68,
  emiMisc5:69,emiMisc6:70,emiMisc7:71,emiMisc8:72,cashflow1:73,cashflow2:74,
  cashflow3:75,cashflow4:76,cashflow5:77,cashflow6:78,cashflow7:79,cashflow8:80,
  akShareOfEmi:81,aksShareOfEmi:82,driveLink:83,downPaymentPct:84,
  revisedDateData:85,helper1:86,
  welcomeMsgText:87,emiMsgText:88,lastDateMsgText:89,thankYouMsgText:90,loanClosingMsgText:91,
  revisedDateMsg:92,
};

// ── GET ───────────────────────────────────────────────────────────────────
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';

  // ── Auth check: all actions except readUsers require PIN verification ──
  if (action !== 'readUsers') {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const _userId = (e && e.parameter && e.parameter._userId) || '';
    const _pin    = (e && e.parameter && e.parameter._pin) || '';
    if (!_userId || !_pin || !verifyAuth(ss, _userId, _pin)) {
      return jsonResponse({ok:false, error:'Unauthorized'});
    }
  }

  // ── Slim: card columns only (49 cols) — instant card rendering ──────
  if (action === 'readLoansSlim') {
    try {
      const cache = CacheService.getScriptCache();
      const cached = cache.get('loans_slim');
      if (cached) return jsonResponse({ok:true, loans: JSON.parse(cached)});

      const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
      const sheet = ss.getSheetByName(DATA_SHEET);
      if (!sheet || sheet.getLastRow() < 2) return jsonResponse({ok:true,loans:[]});
      const nRows = sheet.getLastRow() - 1;
      const raw   = sheet.getRange(2, 1, nRows, 49).getValues();
      const loans = raw
        .filter(r => r[C.loanId] && String(r[C.loanId]).trim())
        .map(r => {
          const isDefaulted  = r[C.defaulted] === true;
          const emiCompleted = String(r[C.emiCompleted]||'').trim().toUpperCase() === 'YES';
          let status = 'Active';
          if (emiCompleted) status = 'Closed';
          if (isDefaulted)  status = 'Defaulted';
          return {
            loanId:          String(r[C.loanId]).trim(),
            customerName:    String(r[C.customerName]||'').trim(),
            monthlyEmi:      parseFloat(r[C.monthlyEmi])||0,
            nextEmiDate:     fmtDate(r[C.nextEmiDate]),
            billDate:        fmtDate(r[C.billDate]),
            model:           String(r[C.model]||'').trim(),
            lateEmis:        parseInt(r[C.lateEmis])||0,
            numReceivedEmi:  parseInt(r[C.numReceivedEmi])||0,
            emiDuration:     parseInt(r[C.emiDuration])||0,
            akShare:         parseFloat(r[C.akShare])||0,
            aksShare:        parseFloat(r[C.aksShare])||0,
            extraEmiReceived:parseFloat(r[C.extraEmiReceived])||0,
            emiStartDate:    fmtDate(r[C.emiStartDate]),
            lastEmiDate:     fmtDate(r[C.lastEmiDate]),
            phone:           (r[C.phone] instanceof Date) ? '' : String(r[C.phone]||'').trim(),
            aadhaarPan:      (r[C.aadhaarPan] instanceof Date) ? '' : String(r[C.aadhaarPan]||'').trim(),
            defaultComment:  String(r[C.defaultComment]||'').trim(),
            isDefaulted, emiCompleted, status, _slim:true,
          };
        });
      const loansSlimStr = JSON.stringify(loans);
      if (loansSlimStr.length <= 95000) cache.put('loans_slim', loansSlimStr, 15);
      return jsonResponse({ok:true, loans});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  // ── Full loan data for all loans (93 cols + miscType enrichment) ────
  if (action === 'readAllLoans') {
    try {
      const cache = CacheService.getScriptCache();
      const cached = cache.get('loans_full');
      if (cached) return jsonResponse({ok:true, loans: JSON.parse(cached)});

      const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
      const sheet = ss.getSheetByName(DATA_SHEET);
      if (!sheet || sheet.getLastRow() < 2) return jsonResponse({ok:true,loans:[]});
      const nCols = 93;
      const raw   = sheet.getRange(2, 1, sheet.getLastRow()-1, nCols).getValues();
      const loans = raw.filter(r => r[C.loanId] && String(r[C.loanId]).trim()).map(r => buildFullLoan(r));

      // Enrich all loans with miscType from logged EMI sheet (eliminates per-card round-trip)
      try {
        const logSheet = ss.getSheetByName(LOGGED_EMI_SHEET);
        if (logSheet && logSheet.getLastRow() > 1) {
          const logData = logSheet.getRange(2, 1, logSheet.getLastRow()-1, 12).getValues();
          const byLoan = {};
          logData.forEach(r => {
            const lid = String(r[0]||'').replace(/_\d+$/, '');
            if (!byLoan[lid]) byLoan[lid] = [];
            byLoan[lid].push(r);
          });
          loans.forEach(loan => {
            const rows = byLoan[loan.loanId];
            if (rows) rows.forEach(r => {
              const emiNum = parseInt(r[4]);
              const mt = String(r[11]||'').trim();
              if (mt && loan.slots) {
                const slot = loan.slots.find(s => s.num === emiNum);
                if (slot) slot.miscType = mt;
              }
            });
          });
        }
      } catch(e) { /* non-critical */ }

      const loansStr = JSON.stringify(loans);
      if (loansStr.length <= 95000) cache.put('loans_full', loansStr, 600);
      return jsonResponse({ok:true, loans});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  // ── Full detail for one loan — on card click ────────────────────────
  if (action === 'readLoanDetail') {
    const loanId = (e.parameter && e.parameter.loanId) || '';
    try {
      const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
      const sheet = ss.getSheetByName(DATA_SHEET);
      if (!sheet || sheet.getLastRow() < 2) return jsonResponse({ok:false,error:'No data'});
      const nCols = sheet.getLastColumn();
      const raw   = sheet.getRange(2,1,sheet.getLastRow()-1,nCols).getValues();
      const row   = raw.find(r => String(r[C.loanId]).trim() === String(loanId).trim());
      if (!row) return jsonResponse({ok:false,error:'Not found'});
      const loan = buildFullLoan(row);
      // Enrich slots with miscType from logged EMI sheet
      try {
        const logSheet = ss.getSheetByName(LOGGED_EMI_SHEET);
        if (logSheet && logSheet.getLastRow() > 1) {
          const logData = logSheet.getRange(2, 1, logSheet.getLastRow()-1, 12).getValues();
          const prefix = String(loanId) + '_';
          logData.forEach(r => {
            if (String(r[0]||'').startsWith(prefix)) {
              const emiNum = parseInt(r[4]);
              const miscType = String(r[11]||'').trim();
              if (miscType && loan.slots) {
                const slot = loan.slots.find(s => s.num === emiNum);
                if (slot) slot.miscType = miscType;
              }
            }
          });
        }
      } catch(e) { /* non-critical */ }
      // Enrich with revised dates for this loan
      try {
        const revSheet = ss.getSheetByName(REVISED_DATES_SHEET);
        if (revSheet && revSheet.getLastRow() > 1) {
          const revData = revSheet.getRange(2, 1, revSheet.getLastRow()-1, 6).getValues();
          loan.revisedDates = revData
            .filter(r => String(r[0]||'').trim() === loanId)
            .map(r => ({
              emiNum: parseInt(r[1])||0,
              revisedDate: fmtDate(r[2]),
              amount: parseFloat(r[3])||0,
              note: String(r[4]||'').trim(),
              createdAt: String(r[5]||''),
            }));
        }
      } catch(e) { /* non-critical */ }
      return jsonResponse({ok:true, loan});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  // ── Read all revised dates (lightweight, for Log EMI tab) ──────────
  if (action === 'readRevisedDates') {
    try {
      const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
      const sheet = ss.getSheetByName(REVISED_DATES_SHEET);
      if (!sheet || sheet.getLastRow() < 2) return jsonResponse({ok:true, dates:[]});
      const rows = sheet.getRange(2, 1, sheet.getLastRow()-1, 6).getValues();
      const dates = rows.filter(r => r[0] && String(r[0]).trim()).map(r => ({
        loanId: String(r[0]||'').trim(),
        emiNum: parseInt(r[1])||0,
        revisedDate: fmtDate(r[2]),
        amount: parseFloat(r[3])||0,
        note: String(r[4]||'').trim(),
        createdAt: String(r[5]||''),
      }));
      return jsonResponse({ok:true, dates});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  // ── Read pending submissions ────────────────────────────────────────
  if (action === 'readPending') {
    try {
      const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
      return jsonResponse({ok:true, pending:readAllPending(ss)});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  // ── Read approved partials (for partial payments) ──────────────────
  if (action === 'readApprovedPartials') {
    try {
      const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
      const sheet = ss.getSheetByName(UNAPP_EMI_SHEET);
      if (!sheet || sheet.getLastRow() < 2) return jsonResponse({ok:true, partials:[]});
      const rows = sheet.getDataRange().getValues();
      const partials = rows.slice(1)
        .filter(r => String(r[1]).toLowerCase()==='approved' && String(r[16]||'').toLowerCase()==='partial payment')
        .map(r => ({
          id: String(r[0]), loanId: String(r[5]||'').replace(/_\d+$/,''),
          customerName: r[6], emiNum: r[9], emiDate: r[10],
          receivedDate: r[13], amount: parseFloat(r[15])||0,
        }));
      return jsonResponse({ok:true, partials});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  // ── Read users ──────────────────────────────────────────────────────
  if (action === 'readUsers') {
    try {
      const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
      return jsonResponse({ok:true, users:readAllUsersPublic(ss)});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  // ── Read blocked usernames (for admin Unblock button) ────────────────
  if (action === 'readBlockedUsers') {
    const props = ScriptProperties.getProperties();
    const blocked = Object.keys(props)
      .filter(k => k.startsWith('blocked_'))
      .map(k => k.replace('blocked_', ''));
    return jsonResponse({ok:true, blocked});
  }

  // ── Read message templates (columns CJ:CN, row 1) ───────────────────
  if (action === 'readMessageTemplates') {
    try {
      const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
      const sheet = ss.getSheetByName(DATA_SHEET);
      if (!sheet) return jsonResponse({ok:false, error:'Data sheet not found'});
      const nCols = sheet.getLastColumn();
      // CJ=88, CN=92 — if sheet is narrower, return empty
      if (nCols < 88) return jsonResponse({ok:true, templates:{welcome:'',emiReminder:'',lastDate:'',thankYou:'',loanClosing:''}});
      const endCol = Math.min(nCols, 92);
      const row    = sheet.getRange(1, 88, 1, endCol - 87).getValues()[0];
      return jsonResponse({ok:true, templates:{
        welcome:     String(row[0]||''),
        emiReminder: String(row[1]||''),
        lastDate:    String(row[2]||''),
        thankYou:    String(row[3]||''),
        loanClosing: String(row[4]||''),
      }});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  // ── Read all loans for message generation (92 cols, includes CJ:CN) ─
  if (action === 'readAllLoansForMsgs') {
    try {
      const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
      const sheet = ss.getSheetByName(DATA_SHEET);
      if (!sheet || sheet.getLastRow() < 2) return jsonResponse({ok:true, loans:[]});
      const nCols = 93; // up to revisedDateMsg (index 92)
      const raw   = sheet.getRange(2, 1, sheet.getLastRow()-1, nCols).getValues();
      const loans = raw.map(r => buildFullLoan(r));
      return jsonResponse({ok:true, loans});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  // ── Read Config sheet (lastMessageSent from B3) ────────────────────
  if (action === 'readConfig') {
    try {
      const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
      const sheet = ss.getSheetByName('Config');
      if (!sheet) return jsonResponse({ok:true, lastMessageSent:''});
      const val = sheet.getRange('B3').getValue();
      const lastMessageSent = (val instanceof Date && !isNaN(val))
        ? Utilities.formatDate(val, 'IST', 'yyyy-MM-dd')
        : String(val || '');
      return jsonResponse({ok:true, lastMessageSent});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  return jsonResponse({ok:true, message:'AKS Finance running.'});
}

// ── POST ──────────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    // Support FormData (e.parameter.payload) and raw JSON body
    const raw     = (e.parameter && e.parameter.payload)
                  ? e.parameter.payload
                  : (e.postData && e.postData.contents ? e.postData.contents : '{}');
    const payload = JSON.parse(raw);
    const ss      = SpreadsheetApp.openById(SPREADSHEET_ID);

    // ── Login: skip auth (user hasn't logged in yet) ────────────────────
    if (payload.action === 'login') {
      const { username, pin } = payload;
      if (!username) return jsonResponse({ok:false, error:'Username required'});

      // Check if account is permanently blocked
      if (ScriptProperties.getProperty('blocked_' + username)) {
        return jsonResponse({ok:false, error:'Account blocked. Contact admin.'});
      }

      const users = readAllUsers(ss);
      const user = users.find(u => u.username === username && u.pin === pin);

      if (user) {
        // Success — reset failed attempts
        ScriptProperties.deleteProperty('failed_' + username);
        return jsonResponse({ok:true, user, token: createSession(user)});
      }

      // Failed attempt — block after 5
      const MAX_FAILS = 5;
      let attempts = parseInt(ScriptProperties.getProperty('failed_' + username) || '0');
      attempts++;
      ScriptProperties.setProperty('failed_' + username, String(attempts));

      if (attempts >= MAX_FAILS) {
        ScriptProperties.setProperty('blocked_' + username, 'true');
        ScriptProperties.deleteProperty('failed_' + username);
        return jsonResponse({ok:false, error:'Account blocked due to 5 failed attempts. Contact admin.'});
      }

      return jsonResponse({ok:false, error:'Invalid credentials. ' + (MAX_FAILS - attempts) + ' attempt(s) remaining.'});
    }

    // ── Unblock user (admin only) ───────────────────────────────────────
    if (payload.action === 'unblockUser') {
      const { username } = payload;
      if (!verifyAuth(ss, payload._userId, payload._pin)) return jsonResponse({ok:false, error:'Unauthorized'});
      ScriptProperties.deleteProperty('blocked_' + username);
      ScriptProperties.deleteProperty('failed_' + username);
      return jsonResponse({ok:true});
    }

    // ── Restore session from token (no PIN re-entry) ────────────────────
    if (payload.action === 'restoreSession') {
      const { token } = payload;
      if (token) {
        const userJson = ScriptProperties.getProperty('session_' + token);
        if (userJson) return jsonResponse({ok:true, user: JSON.parse(userJson)});
      }
      return jsonResponse({ok:false, error:'Invalid or expired session'});
    }

    // ── Verify caller identity on every mutation ───────────────────────
    const _userId = String(payload._userId || '').trim();
    const _pin    = String(payload._pin || '').trim();
    if (!_userId || !_pin || !verifyAuth(ss, _userId, _pin)) {
      return jsonResponse({ok:false, error:'Unauthorized'});
    }

    // ── Save new loan submission ──────────────────────────────────────
    if (payload.action === 'saveLoan') {
      const p = payload.item, d = p.data;
      const headers = [
        'ID','Status','SubmittedBy','SubmittedAt','Note',
        'Bill Date','Customer Name','Customer mobile no','Customer AADHAR / PAN',
        'Mobile model','Device Type','Mobile amount','Down payment','Processing Fee',
        'Interest','EMI Duration','EMI Start Date',
        'Guarantor/ Alternate no/ Comments','App Lock Charge','AK Share','Rate of Interest'
      ];
      const sheet = ensureSheet(ss, UNAPP_LOAN_SHEET, headers);
      sheet.appendRow([
        p.id, p.status, p.submittedBy, p.submittedAt, '',
        fmtDateFromYMD(d.billDate), d.customerName||'', d.phone||'', d.idNum||'',
        d.model||'', d.deviceType||'', d.price||0, d.downPayment||0, d.processingFee||0,
        d.interest||0, d.tenure||0, fmtDateFromYMD(d.emiStart),
        d.guarantor||'', d.appLockCharge||0, (d.akShare||0)/100,
        (d.rateOfInterest||0)/100
      ]);
      return jsonResponse({ok:true, pending:readAllPending(ss)});
    }

    // ── Save new EMI submission ───────────────────────────────────────
    if (payload.action === 'saveEmi') {
      const p = payload.item, d = p.data;
      // Columns: EMI_ID, Customer Name, Mobile Model, EMI_Start_Date, EMI_Number,
      // EMI_Date, Loan ID, Received, Received_date, MISC, Cashflow, MISC Type
      const headers = [
        'ID','Status','SubmittedBy','SubmittedAt','Note',
        'EMI_ID','Customer Name','Mobile Model','EMI_Start_Date','EMI_Number',
        'EMI_Date','Loan ID','Received','Received_date','MISC','Cashflow','MISC Type'
      ];
      const sheet = ensureSheet(ss, UNAPP_EMI_SHEET, headers);

      // EMI_ID = LoanID_EMINumber  e.g. Roshan0070/1_5
      const emiId = (d.loanId||'') + '_' + (d.emiNum||'');

      // Get EMI start date from master Data sheet
      let emiStartDate = '';
      const ds = ss.getSheetByName(DATA_SHEET);
      if (ds && ds.getLastRow() > 1) {
        const ids = ds.getRange(2, C.loanId+1, ds.getLastRow()-1, 1).getValues();
        for (let i=0;i<ids.length;i++){
          if (String(ids[i][0]).trim()===String(d.loanId||'').trim()){
            const row = ds.getRange(i+2, 1, 1, ds.getLastColumn()).getValues()[0];
            emiStartDate = row[C.emiStartDate];
            break;
          }
        }
      }

      // Format dates as DD-Mon-YY
      const receivedDateFmt = fmtDateFromYMD(d.date||'');
      // Use frontend scheduledDate if provided, otherwise compute from Data sheet
      let emiDateFmt = d.scheduledDate ? fmtDate(parseFlexDate(d.scheduledDate)) : '';
      if (!emiDateFmt && emiStartDate && d.emiNum) {
        const sd = new Date(emiStartDate);
        if (!isNaN(sd)) {
          sd.setMonth(sd.getMonth() + (d.emiNum - 1));
          emiDateFmt = fmtDate(sd);
        }
      }

      const misc     = (d.amount||0) - (d.expectedAmount||0);
      const received = d.received !== false; // default TRUE
      const miscType = d.reason || '';

      sheet.appendRow([
        p.id, p.status, p.submittedBy, p.submittedAt, '',
        emiId, d.customerName||'', d.model||'', d.emiStartDate||'', d.emiNum||'',
        emiDateFmt, d.loanId||'', received, receivedDateFmt, misc, d.amount||0, miscType
      ]);
      return jsonResponse({ok:true, pending:readAllPending(ss)});
    }

    // ── Update (edit) a row ───────────────────────────────────────────
    if (payload.action === 'updatePending') {
      const { id, type, data:d } = payload;
      const sheetName = type === 'loan' ? UNAPP_LOAN_SHEET : UNAPP_EMI_SHEET;
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) return jsonResponse({ok:false,error:'Sheet not found'});
      const rows  = sheet.getDataRange().getValues();
      for (let i=1;i<rows.length;i++){
        if (String(rows[i][0])===String(id)){
          if (type==='loan'){
            // Sheet: BillDate(5), CustomerName(6), Phone(7), Aadhaar(8),
            // Model(9), DeviceType(10), Price(11), DownPayment(12), ProcessingFee(13),
            // Interest(14), Tenure(15), EmiStart(16), Guarantor(17), AppLock(18), AKShare(19), RateOfInterest(20)
            sheet.getRange(i+1,6,1,16).setValues([[
              fmtDateFromYMD(d.billDate),d.customerName||'',d.phone||'',d.idNum||'',
              d.model||'',d.deviceType||'',d.price||0,d.downPayment||0,d.processingFee||0,
              d.interest||0,d.tenure||0,fmtDateFromYMD(d.emiStart),
              d.guarantor||'',d.appLockCharge||0,(d.akShare||0)/100,(d.rateOfInterest||0)/100
            ]]);
          } else {
            // Sheet: EMI_ID(5), CustomerName(6), Model(7), EMI_Start_Date(8), EMI_Number(9),
            // EMI_Date(10), LoanID(11), Received(12), Received_date(13), MISC(14), Cashflow(15), MISC_Type(16)
            const newMisc = (d.amount||0) - (d.expectedAmount||0);
            sheet.getRange(i+1,6,1,12).setValues([[
              (d.loanId||'')+'_'+(d.emiNum||''),d.customerName||'',d.model||'',
              fmtDateFromYMD(d.emiStartDate),d.emiNum||'',
              rows[i][10],rows[i][11],rows[i][12],
              fmtDateFromYMD(d.date||''),
              newMisc,d.amount||0,d.miscType||''
            ]]);
          }
          return jsonResponse({ok:true, pending:readAllPending(ss)});
        }
      }
      return jsonResponse({ok:false,error:'ID not found'});
    }

    // ── Add user ────────────────────────────────────────────────────────
    if (payload.action === 'addUser') {
      const { id, username, pin, name, role, perms } = payload;
      const headers = ['ID','Username','PIN','Name','Role','loan','emi','allLoans','approvals'];
      const sheet = ensureSheet(ss, USERS_SHEET, headers);
      sheet.appendRow([id, username, pin, name, role,
        perms.loan ? 'TRUE' : 'FALSE',
        perms.emi ? 'TRUE' : 'FALSE',
        perms.allLoans ? 'TRUE' : 'FALSE',
        perms.approvals ? 'TRUE' : 'FALSE',
      ]);
      return jsonResponse({ok:true, users:readAllUsers(ss)});
    }

    // ── Remove user ─────────────────────────────────────────────────────
    if (payload.action === 'removeUser') {
      const { id } = payload;
      const sheet = ss.getSheetByName(USERS_SHEET);
      if (!sheet) return jsonResponse({ok:false, error:'Sheet not found'});
      const vals = sheet.getDataRange().getValues();
      for (let i=vals.length-1;i>=1;i--){
        if (String(vals[i][0])===String(id)){ sheet.deleteRow(i+1); break; }
      }
      return jsonResponse({ok:true, users:readAllUsers(ss)});
    }

    // ── Approve ───────────────────────────────────────────────────────
    if (payload.action === 'approvePending') {
      const { id, type } = payload;
      const sheetName = type==='loan' ? UNAPP_LOAN_SHEET : UNAPP_EMI_SHEET;
      const row = readRowById(ss, sheetName, id);
      if (!row) return jsonResponse({ok:false, error:'Row not found'});
      if (type==='loan') {
        appendToInput(ss, row);
        deleteFromSheet(ss, sheetName, id);
      } else {
        // Check if this EMI already exists in the logged EMI sheet
        const emiId = String(row[5] || '').trim();
        if (emiId) {
          const logSheet = ss.getSheetByName(LOGGED_EMI_SHEET);
          if (logSheet && logSheet.getLastRow() > 1) {
            const logData = logSheet.getRange(2, 1, logSheet.getLastRow()-1, 1).getValues();
            if (logData.some(r => String(r[0]).trim() === emiId)) {
              return jsonResponse({ok:false, error:'duplicate_emi'});
            }
          }
        }
        // Partial payment: approve in-place (stay in unapproved sheet)
        const miscType = String(row[16] || '').toLowerCase();
        const rowStatus = String(row[1] || '').toLowerCase();

        // ── Early loan closing settlement: auto-complete all remaining EMIs ──
        if (miscType === 'early loan closing settlement') {
          const loanId = String(row[5]||'').replace(/_\d+$/, '');
          if (loanId) {
            const ds = ss.getSheetByName(DATA_SHEET);
            let loanRow = null, rowNum = 0;
            if (ds && ds.getLastRow() > 1) {
              const ids = ds.getRange(2, C.loanId+1, ds.getLastRow()-1, 1).getValues();
              for (let i=0;i<ids.length;i++) {
                if (String(ids[i][0]).trim() === loanId) {
                  loanRow = ds.getRange(i+2, 1, 1, ds.getLastColumn()).getValues()[0];
                  rowNum = i + 2;
                  break;
                }
              }
            }
            if (!loanRow) { deleteFromSheet(ss, sheetName, id); return jsonResponse({ok:true, pending:readAllPending(ss)}); }
            const duration = parseInt(loanRow[C.emiDuration]) || 0;
            const stdEmi = parseFloat(loanRow[C.monthlyEmi]) || 0;
            const numRcv = parseInt(loanRow[C.numReceivedEmi]) || 0;
            const settlementAmt = parseFloat(row[15]) || 0;
            const receivedDate = String(fmtDate(row[13]) || '').trim();
            const remaining = duration - numRcv;

            if (remaining > 0) {
              // Parse EMI start date for computing per-EMI scheduled dates
              const emiStartRaw = loanRow[C.emiStartDate];
              const emiStart = (emiStartRaw instanceof Date && !isNaN(emiStartRaw))
                ? new Date(emiStartRaw) : parseFlexDate(emiStartRaw);

              const logSheet  = ensureSheet(ss, LOGGED_EMI_SHEET,
                ['EMI_ID','Customer Name','Mobile Model','EMI_Start_Date','EMI_Number',
                 'EMI_Date','Loan ID','Received','Received_date','MISC','Cashflow','MISC Type']);

              for (let i = 0; i < remaining; i++) {
                const slotIdx = numRcv + i;
                const isLast  = (i === remaining - 1);
                const cash    = isLast ? settlementAmt : 0;

                // Compute scheduled EMI date
                let scheduledDate = '';
                if (emiStart) {
                  const d = new Date(emiStart);
                  d.setMonth(d.getMonth() + slotIdx);
                  scheduledDate = fmtDate(d);
                }

                logSheet.appendRow([
                  String(loanRow[C.loanId]||'').trim() + '_' + (slotIdx + 1),
                  loanRow[C.customerName] || '',
                  loanRow[C.model] || '',
                  loanRow[C.emiStartDate] || '',
                  slotIdx + 1,
                  scheduledDate,
                  loanId,
                  true,
                  receivedDate,
                  cash - stdEmi,
                  cash,
                  'Early loan closing settlement',
                ]);
              }
            }
          }
          deleteFromSheet(ss, sheetName, id);
        } else if (miscType === 'partial payment' && rowStatus === 'pending') {
          const sheet = ss.getSheetByName(UNAPP_EMI_SHEET);
          const data = sheet.getDataRange().getValues();
          for (let i=1;i<data.length;i++) {
            if (String(data[i][0])===String(id)) { sheet.getRange(i+1,2).setValue('approved'); break; }
          }
        } else {
          appendToLoggedEmi(ss, row);
          deleteFromSheet(ss, sheetName, id);
        }
      }
      try { CacheService.getScriptCache().remove('loans_slim'); } catch(e) {}
      try { CacheService.getScriptCache().remove('loans_full'); } catch(e) {}
      return jsonResponse({ok:true, pending:readAllPending(ss)});
    }
    // ── Update remaining partial payment ──────────────────────────────
    if (payload.action === 'updateRemainingEmi') {
      const { id, additionalAmount, newDate } = payload;
      const sheet = ss.getSheetByName(UNAPP_EMI_SHEET);
      if (!sheet) return jsonResponse({ok:false, error:'Sheet not found'});
      const data = sheet.getDataRange().getValues();
      for (let i=1;i<data.length;i++) {
        if (String(data[i][0])===String(id)) {
          const currentCashflow = parseFloat(data[i][15]) || 0;
          const newCashflow = currentCashflow + (parseFloat(additionalAmount) || 0);
          const dateFmt = fmtDateFromYMD(newDate || '');
          sheet.getRange(i+1, 2).setValue('pending');   // Status
          sheet.getRange(i+1, 14).setValue(dateFmt);     // Received_date
          sheet.getRange(i+1, 15).setValue(0);            // Reset MISC to 0
          sheet.getRange(i+1, 16).setValue(newCashflow);  // Cashflow
          sheet.getRange(i+1, 17).setValue('');            // Clear miscType
          break;
        }
      }
      return jsonResponse({ok:true, pending:readAllPending(ss)});
    }

    // ── Reject ────────────────────────────────────────────────────────
    if (payload.action === 'rejectPending') {
      const { id, type, note } = payload;
      const sheet = ss.getSheetByName(type==='loan' ? UNAPP_LOAN_SHEET : UNAPP_EMI_SHEET);
      if (!sheet) return jsonResponse({ok:false,error:'Sheet not found'});
      const rows = sheet.getDataRange().getValues();
      for (let i=1;i<rows.length;i++){
        if (String(rows[i][0])===String(id)){
          sheet.getRange(i+1,2).setValue('rejected');
          sheet.getRange(i+1,5).setValue(note||'');
          return jsonResponse({ok:true, pending:readAllPending(ss)});
        }
      }
      return jsonResponse({ok:false,error:'ID not found'});
    }

    // ── Deduplicate PIDs in both unapproved sheets ─────────────────────
    if (payload.action === 'dedupPids') {
      const fixed = {loan:0, emi:0};
      [UNAPP_LOAN_SHEET, UNAPP_EMI_SHEET].forEach(sheetName => {
        const sheet = ss.getSheetByName(sheetName);
        if (!sheet || sheet.getLastRow() < 2) return;
        const rows  = sheet.getDataRange().getValues();
        const seen  = {};
        for (let i=1; i<rows.length; i++) {
          const id = String(rows[i][0]||'');
          if (!id) continue;
          if (seen[id] !== undefined) {
            const newId = id + '_' + (++seen[id]);
            sheet.getRange(i+1, 1).setValue(newId);
            fixed[sheetName === UNAPP_LOAN_SHEET ? 'loan' : 'emi']++;
          } else {
            seen[id] = 0;
          }
        }
      });
      return jsonResponse({ok:true, fixed, pending:readAllPending(ss)});
    }

    // ── Update last message sent date in Config!B3 ──────────────────
    if (payload.action === 'updateLastMessageSent') {
      const sheet = ss.getSheetByName('Config') || ss.insertSheet('Config');
      sheet.getRange('B3').setValue(payload.date || new Date());
      return jsonResponse({ok:true});
    }

    // ── Set revised date ────────────────────────────────────────────
    if (payload.action === 'setRevisedDate') {
      const { loanId, emiNum, revisedDate, amount, note } = payload;
      const sheet = ensureSheet(ss, REVISED_DATES_SHEET, ['LoanID','EMI_Num','Revised_Date','Amount','Note','CreatedAt']);
      sheet.appendRow([
        String(loanId||'').trim(),
        parseInt(emiNum)||0,
        fmtDateFromYMD(revisedDate||''),
        parseFloat(amount)||0,
        String(note||'').trim(),
        new Date().toISOString(),
      ]);
      try { CacheService.getScriptCache().remove('loans_slim'); } catch(e) {}
      try { CacheService.getScriptCache().remove('loans_full'); } catch(e) {}
      return jsonResponse({ok:true, pending:readAllPending(ss)});
    }

    return jsonResponse({ok:false, error:'Unknown action: '+payload.action});
  } catch(err){ return jsonResponse({ok:false, error:err.message}); }
}

// ── Run this from GAS editor to fix existing duplicate PIDs ───────────────
function fixDuplicatePids() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const result = {loan:0, emi:0};
  [UNAPP_LOAN_SHEET, UNAPP_EMI_SHEET].forEach(sheetName => {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < 2) return;
    const rows  = sheet.getDataRange().getValues();
    const seen  = {};
    for (let i=1; i<rows.length; i++) {
      const id = String(rows[i][0]||'');
      if (!id) continue;
      if (seen[id] !== undefined) {
        const newId = id + '_' + (++seen[id]);
        sheet.getRange(i+1, 1).setValue(newId);
        result[sheetName === UNAPP_LOAN_SHEET ? 'loan' : 'emi']++;
      } else {
        seen[id] = 0;
      }
    }
  });
  SpreadsheetApp.getUi().alert('Fixed: ' + JSON.stringify(result));
}

// ── Read both unapproved sheets and return combined pending list ──────────
function readAllPending(ss) {
  return [
    ...readUnapproved(ss, UNAPP_LOAN_SHEET, 'loan'),
    ...readUnapproved(ss, UNAPP_EMI_SHEET,  'emi'),
  ];
}

// ── Read unapproved sheet into pending items ───────────────────────────────
function readUnapproved(ss, sheetName, type) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const nCols = sheet.getLastColumn();
  const rows  = sheet.getRange(2,1,sheet.getLastRow()-1,nCols).getValues();
  return rows
    .filter(r => r[0] && String(r[1]).toLowerCase() === 'pending')
    .map(r => {
      let data = {};
      if (type === 'loan') {
        // Cols: ID(0) Status(1) SubmittedBy(2) SubmittedAt(3) Note(4)
        // Bill Date(5) CustomerName(6) Phone(7) Aadhaar(8) Model(9)
        // DeviceType(10) Price(11) Down(12) PFee(13) Interest(14)
        // Tenure(15) EmiStart(16) Guarantor(17) AppLock(18) AKShare(19) RateOfInterest(20)
        data = {
          billDate:fmtDate(r[5]), customerName:r[6], phone:r[7], idNum:r[8],
          model:r[9], deviceType:r[10], price:r[11], downPayment:r[12],
          processingFee:r[13], interest:r[14], tenure:r[15], emiStart:fmtDate(r[16]),
          guarantor:r[17], appLockCharge:r[18], akShare:r[19]*100,
          aksShare:100-(r[19]*100),
          rateOfInterest: (parseFloat(r[20])||0) * 100,
          // Derived fields for display in approval card
          loanId: (String(r[6]).split(' ')[0] || '') + String(r[8]).slice(-4) + '/1',
          monthlyEmi: 0, financeAmount: 0, totalAmount: 0,
          akAmount: 0, aksAmount: 0,
        };
      } else {
        // Cols: ID(0) Status(1) SubmittedBy(2) SubmittedAt(3) Note(4)
        // EMI_ID(5) CustomerName(6) Model(7) EMI_Start_Date(8) EMI_Number(9)
        // EMI_Date(10) LoanID(11) Received(12) Received_date(13) MISC(14) Cashflow(15) MISC_Type(16)
        const cashflow = parseFloat(r[15])||0;
        const misc = parseFloat(r[14])||0;
        const emiIdRaw = String(r[5]||'');
        data = {
          loanId: emiIdRaw.replace(/_\d+$/, ''), customerName:r[6], model:r[7], emiStartDate:fmtDate(r[8]), emiNum:r[9],
          date:fmtDate(r[13]),rowNumber:r[11],received:r[12],
          scheduledDate:fmtDate(r[10]),misc:misc,miscType:r[16],
          amount:cashflow,expectedAmount:cashflow - misc,
        };
      }
      return { id:String(r[0]), type, status:String(r[1]),
               submittedBy:String(r[2]), submittedAt:String(r[3]),
               note:String(r[4]||''), data };
    });
}

// ── Append approved loan to Input sheet ───────────────────────────────────
// row comes from Unapproved_Loan: ID(0) Status(1) SubmittedBy(2) SubmittedAt(3) Note(4)
// Bill Date(5) CustomerName(6) Phone(7) Aadhaar(8) Model(9)
// DeviceType(10) Price(11) Down(12) PFee(13) Interest(14)
// Tenure(15) EmiStart(16) Guarantor(17) AppLock(18) AKShare(19) RateOfInterest(20)
function appendToInput(ss, row) {
  const headers = ['Bill Date','Customer Name','Customer mobile no','Customer AADHAR / PAN',
    'Mobile model','Device Type','Mobile amount','Down payment','Processing Fee','Interest',
    'EMI Duration','EMI Start Date','Guarantor/ Alternate no/ Comments','App Lock Charge',
    'AK Share','AK paid to Kunal','AKS paid to Kunal','Revised Date'];
  const sheet = ensureSheet(ss, INPUT_SHEET, headers);
  sheet.appendRow([
    row[5], row[6], row[7], row[8],
    row[9], row[10], row[11], row[12],
    row[13], row[14], row[15], row[16],
    row[17], row[18], row[19], '', '', '',
  ]);
  const r = sheet.getLastRow();
  sheet.getRange(r, 4).setNumberFormat('@');
  sheet.getRange(r, 13).setNumberFormat('@');
}

// ── Append approved EMI to logged EMI sheet ───────────────────────────────
// row comes from Unapproved_EMI: ID(0) Status(1) SubmittedBy(2) SubmittedAt(3) Note(4)
// EMI_ID(5) CustomerName(6) Model(7) EMI_Start_Date(8) EMI_Number(9)
// EMI_Date(10) LoanID(11) Received(12) Received_date(13) MISC(14) Cashflow(15) MISC_Type(16)
function appendToLoggedEmi(ss, row) {
  const headers = ['EMI_ID','Customer Name','Mobile Model','EMI_Start_Date','EMI_Number',
    'EMI_Date','Loan ID','Received','Received_date','MISC','Cashflow','MISC Type'];
  const sheet = ensureSheet(ss, LOGGED_EMI_SHEET, headers);
  sheet.appendRow([
    row[5], row[6], row[7], row[8], row[9],
    row[10], row[11], row[12], row[13], row[14], row[15], row[16],
  ]);
}

// ── Build full loan object from row ──────────────────────────────────────
function buildFullLoan(r) {
  const dur = parseInt(r[C.emiDuration])||0;
  const emiStartRaw = r[C.emiStartDate];
  const emiStart    = (emiStartRaw instanceof Date&&!isNaN(emiStartRaw))?emiStartRaw:null;
  const eK=[C.emi1,C.emi2,C.emi3,C.emi4,C.emi5,C.emi6,C.emi7,C.emi8];
  const dK=[C.emiDate1,C.emiDate2,C.emiDate3,C.emiDate4,C.emiDate5,C.emiDate6,C.emiDate7,C.emiDate8];
  const mK=[C.emiMisc1,C.emiMisc2,C.emiMisc3,C.emiMisc4,C.emiMisc5,C.emiMisc6,C.emiMisc7,C.emiMisc8];
  const cK=[C.cashflow1,C.cashflow2,C.cashflow3,C.cashflow4,C.cashflow5,C.cashflow6,C.cashflow7,C.cashflow8];
  const slots=[];
  for(let i=0;i<Math.min(dur,8);i++){
    let sd='';
    if(emiStart){const d=new Date(emiStart);d.setMonth(d.getMonth()+i);sd=fmtDate(d);}
    slots.push({num:i+1,received:r[eK[i]]===true,scheduledDate:sd,
      receivedDate:fmtDate(r[dK[i]]),misc:parseFloat(r[mK[i]])||0,cashflow:parseFloat(r[cK[i]])||0});
  }
  const isDefaulted  = r[C.defaulted]===true;
  const emiCompleted = String(r[C.emiCompleted]||'').trim().toUpperCase()==='YES';
  let status='Active'; if(emiCompleted) status='Closed'; if(isDefaulted) status='Defaulted';
  return {
    loanId:String(r[C.loanId]).trim(),billDate:fmtDate(r[C.billDate]),
    customerName:String(r[C.customerName]||'').trim(),phone:(r[C.phone] instanceof Date) ? '' : String(r[C.phone]||'').trim(),
    aadhaarPan:(r[C.aadhaarPan] instanceof Date) ? '' : String(r[C.aadhaarPan]||'').trim(),model:String(r[C.model]||'').trim(),
    deviceType:String(r[C.deviceType]||'').trim(),mobileAmount:parseFloat(r[C.mobileAmount])||0,
    downPayment:parseFloat(r[C.downPayment])||0,processingFee:parseFloat(r[C.processingFee])||0,
    interest:parseFloat(r[C.interest])||0,emiDuration:dur,emiStartDate:fmtDate(r[C.emiStartDate]),
    totalAmount:parseFloat(r[C.totalAmount])||0,monthlyEmi:parseFloat(r[C.monthlyEmi])||0,
    financeAmount:parseFloat(r[C.financeAmount])||0,appLockCharge:parseFloat(r[C.appLockCharge])||0,
    akShare:parseFloat(r[C.akShare])||0,aksShare:parseFloat(r[C.aksShare])||0,
    akAmount:parseFloat(r[C.akAmount])||0,aksAmount:parseFloat(r[C.aksAmount])||0,
    guarantor:String(r[C.guarantor]||'').trim(),customerId:String(r[C.customerId]||'').trim(),
    nextEmiDate:fmtDate(r[C.nextEmiDate]),lastEmiDate:fmtDate(r[C.lastEmiDate]),
    remainingPrincipal:parseFloat(r[C.remainingPrincipal])||0,
    remainingInterest:parseFloat(r[C.remainingInterest])||0,
    totalPending:parseFloat(r[C.totalPending])||0,receivedTotal:parseFloat(r[C.receivedTotal])||0,
    receivedPrincipal:parseFloat(r[C.receivedPrincipal])||0,
    receivedInterest:parseFloat(r[C.receivedInterest])||0,
    numReceivedEmi:parseInt(r[C.numReceivedEmi])||0,lateEmis:parseInt(r[C.lateEmis])||0,
    latePaymentFine:parseFloat(r[C.latePaymentFine])||0,
    extraEmiReceived:parseFloat(r[C.extraEmiReceived])||0,
    earlyClosing:parseFloat(r[C.earlyClosing])||0,recoveryCharge:parseFloat(r[C.recoveryCharge])||0,
    akPaidToKunal:parseFloat(r[C.akPaidToKunal])||0,aksPaidToKunal:parseFloat(r[C.aksPaidToKunal])||0,
    akShareOfEmi:parseFloat(r[C.akShareOfEmi])||0,aksShareOfEmi:parseFloat(r[C.aksShareOfEmi])||0,
    rateOfInterest:parseFloat(r[C.rateOfInterest])||0,finalRoi:parseFloat(r[C.finalRoi])||0,
    maxInterestDiscount:parseFloat(r[C.maxInterestDiscount])||0,totalEmi:parseInt(r[C.totalEmi])||0,
    downPaymentPct:parseFloat(r[C.downPaymentPct])||0,
    welcomeMsg:r[C.welcomeMsg]===true,closingMsg:r[C.closingMsg]===true,
    lockRemoved:r[C.lockRemoved]===true,
    driveLink:String(r[C.driveLink]||'').trim(),
    defaultComment:String(r[C.defaultComment]||'').trim(),
    revisedDateData:fmtDate(r[C.revisedDateData]),
    welcomeMsgText:String(r[C.welcomeMsgText]||'').trim(),
    emiMsgText:String(r[C.emiMsgText]||'').trim(),
    lastDateMsgText:String(r[C.lastDateMsgText]||'').trim(),
    thankYouMsgText:String(r[C.thankYouMsgText]||'').trim(),
    loanClosingMsgText:String(r[C.loanClosingMsgText]||'').trim(),
    revisedDateMsg:String(r[C.revisedDateMsg]||'').trim(),
    status,isDefaulted,emiCompleted,slots,_slim:false,
  };
}

function ensureSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1,1,1,headers.length).setValues([headers]);
    const hdr = sheet.getRange(1,1,1,headers.length);
    hdr.setFontWeight('bold');
    hdr.setBackground('#534AB7');
    hdr.setFontColor('#ffffff');
    sheet.autoResizeColumns(1,headers.length);
  }
  return sheet;
}

function deleteFromSheet(ss, sheetName, id) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  const vals = sheet.getDataRange().getValues();
  for (let i=vals.length-1;i>=1;i--){
    if (String(vals[i][0])===String(id)){ sheet.deleteRow(i+1); return; }
  }
}

function readRowById(ss, sheetName, id) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return null;
  const nCols = sheet.getLastColumn();
  const rows  = sheet.getRange(2,1,sheet.getLastRow()-1,nCols).getValues();
  for (let i=0;i<rows.length;i++){
    if (String(rows[i][0])===String(id)) return rows[i];
  }
  return null;
}

// Convert YYYY-MM-DD string (from HTML date input) to DD-Mon-YY
function fmtDateFromYMD(str) {
  if (!str) return '';
  const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return fmtDate(parseFlexDate(str)); // fallback
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const yr = String(parseInt(m[1])).slice(-2);
  return parseInt(m[3]) + '-' + M[parseInt(m[2])-1] + '-' + yr;
}

// Parse flexible date strings (DD-Mon-YY, YYYY-MM-DD, etc.) → JS Date
function parseFlexDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  // DD-Mon-YY or DD-Mon-YYYY
  const m1 = s.match(/^(\d{1,2})[\-\/](\w{3})[\-\/](\d{2,4})$/);
  if (m1) {
    const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
    const mon = months[m1[2].toLowerCase()];
    if (mon !== undefined) {
      let yr = parseInt(m1[3]); if (yr<100) yr += yr<50?2000:1900;
      return new Date(yr, mon, parseInt(m1[1]));
    }
  }
  // YYYY-MM-DD
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) return new Date(parseInt(m2[1]), parseInt(m2[2])-1, parseInt(m2[3]));
  return null;
}

function fmtDate(val) {
  if (!val) return '';
  const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (val instanceof Date && !isNaN(val))
    return val.getDate()+'-'+M[val.getMonth()]+'-'+String(val.getFullYear()).slice(-2);
  return String(val).trim();
}

function readAllUsers(ss) {
  const sheet = ss.getSheetByName(USERS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) {
    return [{ id:'u1', username:'AKS', pin:'0000', name:'AKS (You)', role:'admin',
      perms:{ loan:true, emi:true, allLoans:true, approvals:true } }];
  }
  const raw = sheet.getRange(2, 1, sheet.getLastRow()-1, 9).getValues();
  const users = raw.filter(r => r[0] && String(r[0]).trim()).map(r => ({
    id: String(r[0]).trim(),
    username: String(r[1]).trim(),
    pin: String(r[2]).trim(),
    name: String(r[3]).trim(),
    role: String(r[4]).trim(),
    perms: {
      loan:      String(r[5]).toUpperCase() === 'TRUE',
      emi:       String(r[6]).toUpperCase() === 'TRUE',
      allLoans:  String(r[7]).toUpperCase() === 'TRUE',
      approvals: String(r[8]).toUpperCase() === 'TRUE',
    },
  }));
  // Ensure default admin is always present (even if not in the sheet)
  if (!users.some(u => u.id === 'u1')) {
    users.unshift({ id:'u1', username:'AKS', pin:'0000', name:'AKS (You)', role:'admin',
      perms:{ loan:true, emi:true, allLoans:true, approvals:true } });
  }
  return users;
}

// Public version — no PINs exposed (used by GET readUsers)
function readAllUsersPublic(ss) {
  return readAllUsers(ss).map(({ pin, ...u }) => u);
}

function verifyAuth(ss, userId, pin) {
  const users = readAllUsers(ss);
  return users.some(u => u.id === userId && u.pin === pin);
}

// Create a session token for a logged-in user
function createSession(user) {
  const token = Utilities.getUuid();
  ScriptProperties.setProperty('session_' + token, JSON.stringify(user));
  return token;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
