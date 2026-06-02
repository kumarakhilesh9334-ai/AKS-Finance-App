/**
 * AKS Financing — Google Apps Script
 * ====================================
 * Sheets used:
 *   Data             — master loan data (read by app)
 *   Unapproved_Loan  — pending new loan submissions (written on submit, deleted on approve/reject)
 *   Unapproved_EMI   — pending EMI submissions (written on submit, deleted on approve/reject)
 *   Input            — approved new loans appended here
 *   logged EMI       — approved EMI payments appended here
 *
 * SETUP:
 *   1. Open your spreadsheet → Extensions → Apps Script
 *   2. Replace all code with this file
 *   3. Deploy → New deployment → Web app → Execute as Me → Anyone
 *   4. URL already hardcoded in state.js
 */

const SPREADSHEET_ID   = '10mkkgm0DH6gEFfbgkEvnULEnqdMo1ZmekKWf-iqF6EM';
const DATA_SHEET       = 'Data';
const UNAPP_LOAN_SHEET = 'Unapproved_Loan';
const UNAPP_EMI_SHEET  = 'Unapproved_EMI';
const INPUT_SHEET      = 'Input';
const LOGGED_EMI_SHEET = 'logged EMI';

// Column map for Data tab (0-based)
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
  recoveryCharge2:85,helper1:86,
};

// ── GET ───────────────────────────────────────────────────────────────────
function doGet(e) {
  const action = e && e.parameter && e.parameter.action;

  // ── Read master loan data ───────────────────────────────────────────
  if (action === 'readLoans') {
    try {
      const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
      const sheet = ss.getSheetByName(DATA_SHEET);
      if (!sheet || sheet.getLastRow() < 2) return jsonResponse({ ok:true, loans:[] });
      const lastCol = Math.max(Object.values(C).reduce((a,b)=>Math.max(a,b),0)+1, sheet.getLastColumn());
      const raw = sheet.getRange(2,1,sheet.getLastRow()-1,lastCol).getValues();

      const loans = raw.filter(r=>r[C.loanId]&&String(r[C.loanId]).trim()!=='').map(r => {
        const duration = parseInt(r[C.emiDuration])||0;
        const emiStartRaw  = r[C.emiStartDate];
        const emiStartDate = (emiStartRaw instanceof Date&&!isNaN(emiStartRaw))?emiStartRaw:null;
        const emiKeys  = [C.emi1,C.emi2,C.emi3,C.emi4,C.emi5,C.emi6,C.emi7,C.emi8];
        const dateKeys = [C.emiDate1,C.emiDate2,C.emiDate3,C.emiDate4,C.emiDate5,C.emiDate6,C.emiDate7,C.emiDate8];
        const miscKeys = [C.emiMisc1,C.emiMisc2,C.emiMisc3,C.emiMisc4,C.emiMisc5,C.emiMisc6,C.emiMisc7,C.emiMisc8];
        const cashKeys = [C.cashflow1,C.cashflow2,C.cashflow3,C.cashflow4,C.cashflow5,C.cashflow6,C.cashflow7,C.cashflow8];
        const slots = [];
        for (let i=0;i<Math.min(duration,8);i++){
          let scheduledDate='';
          if(emiStartDate){const d=new Date(emiStartDate);d.setMonth(d.getMonth()+i);scheduledDate=fmtDate(d);}
          slots.push({num:i+1,received:r[emiKeys[i]]===true,scheduledDate,receivedDate:fmtDate(r[dateKeys[i]]),misc:parseFloat(r[miscKeys[i]])||0,cashflow:parseFloat(r[cashKeys[i]])||0});
        }
        const isDefaulted  = r[C.defaulted]===true;
        const emiCompleted = String(r[C.emiCompleted]||'').trim().toUpperCase()==='YES';
        let status='Active';
        if(emiCompleted) status='Closed';
        if(isDefaulted)  status='Defaulted';
        return {
          loanId:String(r[C.loanId]).trim(),billDate:fmtDate(r[C.billDate]),
          customerName:String(r[C.customerName]||'').trim(),phone:String(r[C.phone]||'').trim(),
          aadhaarPan:String(r[C.aadhaarPan]||'').trim(),model:String(r[C.model]||'').trim(),
          deviceType:String(r[C.deviceType]||'').trim(),mobileAmount:parseFloat(r[C.mobileAmount])||0,
          downPayment:parseFloat(r[C.downPayment])||0,processingFee:parseFloat(r[C.processingFee])||0,
          interest:parseFloat(r[C.interest])||0,emiDuration:duration,emiStartDate:fmtDate(r[C.emiStartDate]),
          totalAmount:parseFloat(r[C.totalAmount])||0,monthlyEmi:parseFloat(r[C.monthlyEmi])||0,
          financeAmount:parseFloat(r[C.financeAmount])||0,appLockCharge:parseFloat(r[C.appLockCharge])||0,
          akShare:parseFloat(r[C.akShare])||0,aksShare:parseFloat(r[C.aksShare])||0,
          akAmount:parseFloat(r[C.akAmount])||0,aksAmount:parseFloat(r[C.aksAmount])||0,
          guarantor:String(r[C.guarantor]||'').trim(),customerId:String(r[C.customerId]||'').trim(),
          nextEmiDate:fmtDate(r[C.nextEmiDate]),lastEmiDate:fmtDate(r[C.lastEmiDate]),
          remainingPrincipal:parseFloat(r[C.remainingPrincipal])||0,remainingInterest:parseFloat(r[C.remainingInterest])||0,
          totalPending:parseFloat(r[C.totalPending])||0,receivedTotal:parseFloat(r[C.receivedTotal])||0,
          receivedPrincipal:parseFloat(r[C.receivedPrincipal])||0,receivedInterest:parseFloat(r[C.receivedInterest])||0,
          numReceivedEmi:parseInt(r[C.numReceivedEmi])||0,lateEmis:parseInt(r[C.lateEmis])||0,
          latePaymentFine:parseFloat(r[C.latePaymentFine])||0,extraEmiReceived:parseFloat(r[C.extraEmiReceived])||0,
          earlyClosing:parseFloat(r[C.earlyClosing])||0,recoveryCharge:parseFloat(r[C.recoveryCharge])||0,
          akPaidToKunal:parseFloat(r[C.akPaidToKunal])||0,aksPaidToKunal:parseFloat(r[C.aksPaidToKunal])||0,
          akShareOfEmi:parseFloat(r[C.akShareOfEmi])||0,aksShareOfEmi:parseFloat(r[C.aksShareOfEmi])||0,
          rateOfInterest:parseFloat(r[C.rateOfInterest])||0,finalRoi:parseFloat(r[C.finalRoi])||0,
          maxInterestDiscount:parseFloat(r[C.maxInterestDiscount])||0,totalEmi:parseInt(r[C.totalEmi])||0,
          downPaymentPct:parseFloat(r[C.downPaymentPct])||0,
          welcomeMsg:r[C.welcomeMsg]===true,closingMsg:r[C.closingMsg]===true,lockRemoved:r[C.lockRemoved]===true,
          driveLink:String(r[C.driveLink]||'').trim(),defaultComment:String(r[C.defaultComment]||'').trim(),
          status,isDefaulted,emiCompleted,slots,
        };
      });
      return jsonResponse({ok:true,loans});
    } catch(err){return jsonResponse({ok:false,error:err.message});}
  }

  // ── Read unapproved submissions ─────────────────────────────────────
  if (action === 'readPending') {
    try {
      const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
      const loans = readUnapproved(ss, UNAPP_LOAN_SHEET, 'loan');
      const emis  = readUnapproved(ss, UNAPP_EMI_SHEET,  'emi');
      return jsonResponse({ok:true, pending:[...loans,...emis]});
    } catch(err){return jsonResponse({ok:false,error:err.message});}
  }

  return jsonResponse({ok:true,message:'AKS Financing Apps Script running.'});
}

function readUnapproved(ss, sheetName, type) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const rows = sheet.getRange(2,1,sheet.getLastRow()-1,6).getValues();
  return rows
    .filter(r => r[0] && String(r[2]).toLowerCase() === 'pending')
    .map(r => ({
      id:          String(r[0]),
      type,
      status:      String(r[2]),
      submittedBy: String(r[3]),
      submittedAt: String(r[4]),
      note:        String(r[5]||''),
      data:        JSON.parse(r[1]||'{}'),
    }));
}

// ── POST ──────────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

    // ── Save new pending submission ─────────────────────────────────
    if (payload.action === 'savePending') {
      const p = payload.item;
      const sheetName = p.type === 'loan' ? UNAPP_LOAN_SHEET : UNAPP_EMI_SHEET;
      let sheet = ss.getSheetByName(sheetName);
      if (!sheet) {
        sheet = ss.insertSheet(sheetName);
        sheet.getRange(1,1,1,6).setValues([['ID','Data','Status','SubmittedBy','SubmittedAt','Note']]);
        styleHeader(sheet, 6);
      }
      sheet.appendRow([p.id, JSON.stringify(p.data), p.status, p.submittedBy, p.submittedAt, p.note||'']);
      return jsonResponse({ok:true, id:p.id});
    }

    // ── Update (edit) a pending submission ──────────────────────────
    if (payload.action === 'updatePending') {
      const { id, type, data } = payload;
      const sheetName = type === 'loan' ? UNAPP_LOAN_SHEET : UNAPP_EMI_SHEET;
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) return jsonResponse({ok:false,error:'Sheet not found'});
      const rows = sheet.getDataRange().getValues();
      for (let i=1;i<rows.length;i++){
        if (String(rows[i][0])===String(id)){
          sheet.getRange(i+1,2).setValue(JSON.stringify(data));
          return jsonResponse({ok:true});
        }
      }
      return jsonResponse({ok:false,error:'ID not found'});
    }

    // ── Approve: write to destination sheet, delete from unapproved ─
    if (payload.action === 'approvePending') {
      const { id, type, data } = payload;
      const unapprovedSheet = type === 'loan' ? UNAPP_LOAN_SHEET : UNAPP_EMI_SHEET;

      if (type === 'loan') {
        appendToInput(ss, data);
      } else {
        appendToLoggedEmi(ss, data);
      }

      // Mark status as approved in unapproved sheet (then delete row)
      deleteFromSheet(ss, unapprovedSheet, id);
      return jsonResponse({ok:true});
    }

    // ── Reject: update status, keep in sheet ────────────────────────
    if (payload.action === 'rejectPending') {
      const { id, type, note } = payload;
      const sheetName = type === 'loan' ? UNAPP_LOAN_SHEET : UNAPP_EMI_SHEET;
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) return jsonResponse({ok:false,error:'Sheet not found'});
      const rows = sheet.getDataRange().getValues();
      for (let i=1;i<rows.length;i++){
        if (String(rows[i][0])===String(id)){
          sheet.getRange(i+1,3).setValue('rejected');
          sheet.getRange(i+1,6).setValue(note||'');
          return jsonResponse({ok:true});
        }
      }
      return jsonResponse({ok:false,error:'ID not found'});
    }

    return jsonResponse({ok:false,error:'Unknown action'});
  } catch(err){return jsonResponse({ok:false,error:err.message});}
}

// ── Append approved loan to Input sheet ───────────────────────────────────
// Input columns: Bill Date, Customer Name, Customer mobile no, Customer AADHAR/PAN,
// Mobile model, Device Type, Mobile amount, Down payment, Processing Fee, Interest,
// EMI Duration, EMI Start Date, Guarantor/Alternate no/Comments, App Lock Charge,
// AK Share, AK paid to Kunal, AKS paid to Kunal, Revised Date
function appendToInput(ss, d) {
  let sheet = ss.getSheetByName(INPUT_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(INPUT_SHEET);
    const headers = ['Bill Date','Customer Name','Customer mobile no','Customer AADHAR / PAN',
      'Mobile model','Device Type','Mobile amount','Down payment','Processing Fee','Interest',
      'EMI Duration','EMI Start Date','Guarantor/ Alternate no/ Comments','App Lock Charge',
      'AK Share','AK paid to Kunal','AKS paid to Kunal','Revised Date'];
    sheet.getRange(1,1,1,headers.length).setValues([headers]);
    styleHeader(sheet, headers.length);
  }
  sheet.appendRow([
    d.billDate        || '',
    d.customerName    || '',
    d.phone           || '',
    d.idNum           || '',
    d.model           || '',
    d.deviceType      || '',
    d.price           || 0,
    d.downPayment     || 0,
    d.processingFee   || 0,
    d.interest        || 0,
    d.tenure          || 0,
    d.emiStart        || '',
    d.guarantor       || '',
    d.appLockCharge   || 0,
    (d.akShare||0)/100,       // store as decimal (0.5 for 50%)
    '',                        // AK paid to Kunal — filled manually
    '',                        // AKS paid to Kunal — filled manually
    '',                        // Revised Date — filled manually
  ]);
}

// ── Append approved EMI to logged EMI sheet ───────────────────────────────
// Logged EMI columns: EMI_ID, EMI_Date_ID, Loan_ID, EMI_Start_Date,
// EMI_Number, EMI_Date, Row Number, Received, Received_date, MISC, Cashflow
function appendToLoggedEmi(ss, d) {
  let sheet = ss.getSheetByName(LOGGED_EMI_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(LOGGED_EMI_SHEET);
    const headers = ['EMI_ID','EMI_Date_ID','Loan_ID','EMI_Start_Date','EMI_Number',
      'EMI_Date','Row Number','Received','Received_date','MISC','Cashflow'];
    sheet.getRange(1,1,1,headers.length).setValues([headers]);
    styleHeader(sheet, headers.length);
  }

  // Find row number of this loan in the master Data sheet
  const dataSheet = ss.getSheetByName(DATA_SHEET);
  let rowNumber = '';
  if (dataSheet && dataSheet.getLastRow() > 1) {
    const loanIds = dataSheet.getRange(2,C.loanId+1,dataSheet.getLastRow()-1,1).getValues();
    for (let i=0;i<loanIds.length;i++){
      if (String(loanIds[i][0]).trim()===String(d.loanId).trim()){
        rowNumber = i+2; // +2 because data starts at row 2 (row 1 is header)
        break;
      }
    }
  }

  // EMI_ID = LoanID_N,  EMI_Date_ID = scheduledDueDate_N
  const emiId     = d.loanId + '_' + d.emiNum;
  const emiDateId = (d.scheduledDate||d.date||'') + '_' + d.emiNum;
  const misc      = (d.amount||0) - (d.expectedAmount||0); // positive=extra, negative=short

  sheet.appendRow([
    emiId,               // EMI_ID
    emiDateId,           // EMI_Date_ID
    d.loanId,            // Loan_ID
    d.emiStartDate||'',  // EMI_Start_Date
    d.emiNum,            // EMI_Number
    d.date||'',          // EMI_Date (scheduled due date)
    rowNumber,           // Row Number in master Data tab
    true,                // Received (checkbox — TRUE)
    d.date||'',          // Received_date (actual payment date)
    misc,                // MISC (difference from expected)
    d.amount||0,         // Cashflow (exact amount received)
  ]);
}

// ── Delete a row from an unapproved sheet by ID ───────────────────────────
function deleteFromSheet(ss, sheetName, id) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  const rows = sheet.getDataRange().getValues();
  for (let i=rows.length-1;i>=1;i--){
    if (String(rows[i][0])===String(id)){
      sheet.deleteRow(i+1);
      return;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtDate(val) {
  if (!val) return '';
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (val instanceof Date && !isNaN(val)) {
    return val.getDate()+'-'+MONTHS[val.getMonth()]+'-'+String(val.getFullYear()).slice(-2);
  }
  return String(val).trim();
}

function styleHeader(sheet, numCols) {
  const hdr = sheet.getRange(1,1,1,numCols);
  hdr.setFontWeight('bold');
  hdr.setBackground('#534AB7');
  hdr.setFontColor('#ffffff');
  sheet.autoResizeColumns(1, numCols);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
