/**
 * AKS Finance — Google Apps Script (SEPARATE SHEETS)
 * Stock data is in a SEPARATE spreadsheet for faster load times.
 * All other data is in the main spreadsheet.
 */

const SPREADSHEET_ID   = '10mkkgm0DH6gEFfbgkEvnULEnqdMo1ZmekKWf-iqF6EM';
const DATA_SHEET       = 'Data';
const UNAPP_LOAN_SHEET = 'Unapproved_Loan';
const UNAPP_EMI_SHEET  = 'Unapproved_EMI';
const INPUT_SHEET      = 'Input';
const LOGGED_EMI_SHEET     = 'logged EMI';
const USERS_SHEET          = 'Users';
const REVISED_DATES_SHEET  = 'Revised_Dates';
const LOCK_STATUS_SHEET    = 'LockAppStatus';
const STOCK_SHEET          = 'Stock';

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

// ── Per-execution timing ───────────────────────────────────────────────────
// Every GET carries a `_t` object so the client can split the wall-clock time
// it observed into "script execution" vs "Google front-end + redirect hops".
// Marks are DELTAS in ms since the previous mark, so they read directly from
// the response body without doing arithmetic.
//
// tmEnd() runs when jsonResponse() is called, so `total` covers everything up
// to that point and EXCLUDES the final JSON.stringify below. Note that
// readLoansSlim/readAllLoans stringify the payload once already (the
// cache-size check, timed as `str`) and jsonResponse stringifies it a second
// time — add `str` again for the true serialization cost.
let _T = null;
function tmStart()   { _T = { t0: Date.now(), last: Date.now(), out: {} }; }
function tm(name)    { if (!_T) return; const n = Date.now(); _T.out[name] = n - _T.last; _T.last = n; }
function tmFlag(k,v) { if (_T) _T.out[k] = v; }
function tmEnd()     { if (!_T) return null; const o = _T.out; o.total = Date.now() - _T.t0; _T = null; return o; }

// ── Config-driven sheet bounds ─────────────────────────────────────────────
// Config!A = tab name, Config!B = rows in that tab, Config!C = columns in that
// tab. getLastRow()/getLastColumn() each cost a separate round-trip to Google's
// servers (~100-400 ms) no matter how small the tab is, so the small tabs read
// their bounds from Config and ask for the exact rectangle in ONE getRange().
//
// _CFG_BOUNDS is filled at most once per execution. Apps Script hands every run
// a fresh global scope, so a stale value can never leak into the next run.
//
// A missing Config entry, an unreadable Config tab, or a count that no longer
// matches the sheet all fall back to getLastRow()/getLastColumn() - the slow
// path of today. A wrong Config costs speed, never data: rows are over-read (one
// blank row, which every filter below discards) instead of truncated, and
// `minCols` stops a column count that under-counts from cutting off a column
// the mapping code actually dereferences.
let _CFG_BOUNDS = null;

function configBounds(ss) {
  if (_CFG_BOUNDS) return _CFG_BOUNDS;
  const map = {};
  try {
    const cfg = ss.getSheetByName('Config');
    if (cfg) {
      // Read from row 1 so it does not matter whether row 1 holds a header or
      // your first entry: a text header simply fails the numeric test below.
      const vals = cfg.getRange('A1:C100').getValues();
      for (let i = 0; i < vals.length; i++) {
        const name = String(vals[i][0] || '').trim();
        const n = parseInt(vals[i][1], 10);
        const c = parseInt(vals[i][2], 10);
        if (name && n > 0 && c > 0) map[name] = { rows: n, cols: c };
      }
    }
  } catch (e) { /* unreadable Config -> every tab uses the real bounds */ }
  _CFG_BOUNDS = map;
  return map;
}

// Reads data rows from `startRow` down. Three attempts:
//   1. Config rows x max(cols, minCols)  - the count is taken as-is.
//   2. (rows - 1) x same cols            - Config counted the header row too,
//                                          or the grid was trimmed to the used
//                                          range so row rows+1 does not exist.
//   3. getDataRange(), minus the rows above `startRow`
//                                          - Config is missing or simply wrong.
// `minCols` only ever applies to attempts 1 and 2, where Config is the authority
// and could under-count; on attempt 3 the sheet itself is the authority.
function readDataRows(sheet, startRow, b, minCols, p) {
  if (b && b.rows > 0 && b.cols > 0) {
    const cols = Math.max(b.cols, minCols);
    try {
      const rows = sheet.getRange(startRow, 1, b.rows, cols).getValues();
      if (p) tm(p + 'values');
      return rows;
    } catch (e1) {
      try {
        const rows = sheet.getRange(startRow, 1, b.rows - 1, cols).getValues();
        if (p) tm(p + 'values');
        return rows;
      } catch (e2) { /* Config no longer matches this sheet */ }
    }
  }
  // Old behaviour: one getDataRange() + one getValues(), then drop the header.
  // A `fallback` mark in the profile means this tab had no usable Config row.
  if (p) tm(p + 'fallback');
  const rows = sheet.getDataRange().getValues().slice(startRow - 1);
  if (p) tm(p + 'values');
  return rows;
}

// Row count for a bounded getRange() that the caller writes itself. Needed by
// the handleGet loan reads, which sit between two existing tm() marks and
// therefore cannot go through readDataRows' marked path without changing the
// _t key set timing-test asserts.
function dataRowCount(sheet, startRow, b) {
  if (b && b.rows > 0) return b.rows;
  return Math.max(sheet.getLastRow() - startRow + 1, 0);
}

// ── GET ───────────────────────────────────────────────────────────────────
// The real handler, renamed out of doGet so pushSnapshot() can call it and the
// snapshot can never drift from what the API serves. `jsonResponse` is shadowed
// by an identity shim, so this returns the response OBJECT and doGet() wraps it
// for the wire. `opts.internal` is supplied ONLY by pushSnapshot() from inside
// this script — no request parameter can ever reach it — which is what lets
// internal reads skip PIN verification without opening a bypass from outside.
function handleGet(e, opts) {
  const jsonResponse = o => o;
  const internal = !!(opts && opts.internal);
  const action = (e && e.parameter && e.parameter.action) || '';

  // Open spreadsheet ONCE for all handlers
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  tm('open');

  // ── Auth check: all actions except readUsers require PIN verification ──
  // Skipped only for in-script calls (pushSnapshot); `internal` is not
  // reachable from any request parameter.
  if (!internal && action !== 'readUsers') {
    const _userId = (e && e.parameter && e.parameter._userId) || '';
    const _pin    = (e && e.parameter && e.parameter._pin) || '';
    if (!_userId || !_pin || !verifyAuth(ss, _userId, _pin)) {
      return jsonResponse({ok:false, error:'Unauthorized'});
    }
  }
  tm('auth');

  // ── Slim: card columns only (49 cols) — instant card rendering ──────
  if (action === 'readLoansSlim') {
    try {
      const cache = CacheService.getScriptCache();
      const cached = cache.get('loans_slim');
      tm('cache');
      if (cached) {
        const fromCache = JSON.parse(cached);
        tm('parse');
        tmFlag('cached', true);
        return jsonResponse({ok:true, loans: fromCache});
      }
      tmFlag('cached', false);

      const sheet = ss.getSheetByName(DATA_SHEET);
      if (!sheet) return jsonResponse({ok:true,loans:[]});
      const b   = configBounds(ss)[DATA_SHEET];
      let nRows = dataRowCount(sheet, 2, b);
      if (nRows < 1) return jsonResponse({ok:true,loans:[]});
      tm('meta');
      let raw;
      try   { raw = sheet.getRange(2, 1, nRows, 49).getValues(); }
      catch (e) { raw = sheet.getRange(2, 1, dataRowCount(sheet, 2, null), 49).getValues(); }
      tm('read');
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
      tm('map');
      const loansSlimStr = JSON.stringify(loans);
      tm('str');
      // Never cache an empty result: rows surviving the filter but no loanId is
      // an anomaly, not proof the sheet is empty. Caching it (even for 15s) let
      // a degraded read get served to every client that asked next.
      if (loans.length && loansSlimStr.length <= 95000) cache.put('loans_slim', loansSlimStr, 15);
      return jsonResponse({ok:true, loans});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  // ── Full loan data for all loans (93 cols + miscType enrichment) ────
  if (action === 'readAllLoans') {
    try {
      const cache = CacheService.getScriptCache();
      const cached = cache.get('loans_full');
      tm('cache');
      if (cached) {
        const fromCache = JSON.parse(cached);
        tm('parse');
        tmFlag('cached', true);
        return jsonResponse({ok:true, loans: fromCache});
      }
      tmFlag('cached', false);

      const sheet = ss.getSheetByName(DATA_SHEET);
      if (!sheet) return jsonResponse({ok:true,loans:[]});
      const nCols = 93;
      const b   = configBounds(ss)[DATA_SHEET];
      let nRows = dataRowCount(sheet, 2, b);
      if (nRows < 1) return jsonResponse({ok:true,loans:[]});
      tm('meta');
      let raw;
      try   { raw = sheet.getRange(2, 1, nRows, nCols).getValues(); }
      catch (e) { raw = sheet.getRange(2, 1, dataRowCount(sheet, 2, null), nCols).getValues(); }
      tm('read');
      const loans = raw.filter(r => r[C.loanId] && String(r[C.loanId]).trim()).map(r => buildFullLoan(r));
      tm('build');

      // Merge lock-app-removed status from LockAppStatus tab (Data stays read-only)
      const lockMap = getCachedLockStatusMap(ss);
      if (Object.keys(lockMap).length) loans.forEach(loan => {
        if (lockMap[loan.loanId]) loan.lockRemoved = true;
      });
      tm('lock');

      // Enrich all loans with miscType from logged EMI sheet (eliminates per-card round-trip)
      try {
        const byLoan = getCachedEmiLogByLoan(ss);
        loans.forEach(loan => applyMiscTypes(loan, byLoan));
      } catch(e) { /* non-critical */ }
      tm('emi');

      const loansStr = JSON.stringify(loans);
      tm('str');
      // As with loans_slim: an empty payload is never authoritative, and this
      // one would have been served for 10 minutes.
      if (loans.length && loansStr.length <= 95000) cache.put('loans_full', loansStr, 600);
      return jsonResponse({ok:true, loans});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  // ── Full detail for one loan — on card click ────────────────────────
  if (action === 'readLoanDetail') {
    const loanId = (e.parameter && e.parameter.loanId) || '';
    try {
      const cache = CacheService.getScriptCache();
      const ck = loanDetailCacheKey(loanId);
      const hit = cache.get(ck);
      if (hit) {
        try { return jsonResponse({ ok:true, loan: JSON.parse(hit) }); } catch(e) { /* rebuild */ }
      }

      const sheet = ss.getSheetByName(DATA_SHEET);
      if (!sheet) return jsonResponse({ok:false,error:'No data'});
      const b     = configBounds(ss)[DATA_SHEET];
      const nRows = dataRowCount(sheet, 2, b);
      if (nRows < 1) return jsonResponse({ok:false,error:'No data'});
      // The full loan row needs every column; a Config count that under-counts is
      // raised to the 93 the mapping reads, and an over-count is caught below.
      const nCols = (b && b.cols > 0) ? Math.max(b.cols, 93) : sheet.getLastColumn();

      // Targeted lookup: read only the loanId column to locate the row, then read
      // that single row. Previously this read every row x every column and searched
      // in JS, which cost 4-5s per card click.
      let ids;
      try   { ids = sheet.getRange(2, C.loanId + 1, nRows, 1).getValues(); }
      catch (e) { ids = sheet.getRange(2, C.loanId + 1, dataRowCount(sheet, 2, null), 1).getValues(); }
      const want = String(loanId).trim();
      let rel = -1;
      for (let i = 0; i < ids.length; i++) {
        if (String(ids[i][0] || '').trim() === want) { rel = i; break; }
      }
      if (rel === -1) return jsonResponse({ok:false,error:'Not found'});

      let row;
      try   { row = sheet.getRange(rel + 2, 1, 1, nCols).getValues()[0]; }
      catch (e) { row = sheet.getRange(rel + 2, 1, 1, sheet.getLastColumn()).getValues()[0]; }
      const loan = buildFullLoan(row);

      // Merge lock-app-removed status from LockAppStatus tab (Data stays read-only)
      const lockMap = getCachedLockStatusMap(ss);
      if (lockMap[loanId]) loan.lockRemoved = true;

      // Enrich slots with miscType from logged EMI sheet
      try { applyMiscTypes(loan, getCachedEmiLogByLoan(ss)); } catch(e) { /* non-critical */ }

      // Enrich with revised dates for this loan
      try { loan.revisedDates = getCachedRevisedDatesFor(ss, loanId); } catch(e) { /* non-critical */ }

      cachePutIfSmall(cache, ck, loan, DETAIL_CACHE_TTL);
      return jsonResponse({ok:true, loan});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  // ── Read all revised dates (lightweight, for Log EMI tab) ──────────
  if (action === 'readRevisedDates') {
    try {
      return jsonResponse({ok:true, dates: readAllRevisedDates(ss)});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  // ── Read pending submissions ────────────────────────────────────────
  if (action === 'readPending') {
    try {
      return jsonResponse({ok:true, pending:readAllPending(ss)});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  // ── Read approved partials (for partial payments) ──────────────────
  if (action === 'readApprovedPartials') {
    try {
      const sheet = ss.getSheetByName(UNAPP_EMI_SHEET);
      tm('part.sheet');
      if (!sheet) return jsonResponse({ok:true, partials:[]});
      const b = configBounds(ss)[UNAPP_EMI_SHEET];
      tm('part.cfg');
      const rows = readDataRows(sheet, 2, b, 17, 'part.');
      const partials = rows
        .filter(r => String(r[1]).toLowerCase()==='approved' && String(r[16]||'').toLowerCase()==='partial payment')
        .map(r => ({
          id: String(r[0]), loanId: String(r[5]||'').replace(/_\d+$/,''),
          customerName: r[6], emiNum: r[9], emiDate: fmtDate(r[10]),
          receivedDate: fmtDate(r[13]), amount: parseFloat(r[15])||0,
        }));
      tm('part.filter');
      return jsonResponse({ok:true, partials});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  // ── Read users ──────────────────────────────────────────────────────
  if (action === 'readUsers') {
    try {
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
      const sheet = ss.getSheetByName(DATA_SHEET);
      if (!sheet) return jsonResponse({ok:true, loans:[]});
      const nCols = 93; // up to revisedDateMsg (index 92)
      const b   = configBounds(ss)[DATA_SHEET];
      let nRows = dataRowCount(sheet, 2, b);
      if (nRows < 1) return jsonResponse({ok:true, loans:[]});
      let raw;
      try   { raw = sheet.getRange(2, 1, nRows, nCols).getValues(); }
      catch (e) { raw = sheet.getRange(2, 1, dataRowCount(sheet, 2, null), nCols).getValues(); }
      const loans = raw.map(r => buildFullLoan(r));
      // Merge lock-app-removed status from LockAppStatus tab (Data stays read-only)
      const lockMap = readLockStatus(ss);
      if (Object.keys(lockMap).length) loans.forEach(loan => {
        if (lockMap[loan.loanId]) loan.lockRemoved = true;
      });
      return jsonResponse({ok:true, loans});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  // ── Read Config sheet (lastMessageSent from B3) ────────────────────
  if (action === 'readConfig') {
    try {
      const sheet = ss.getSheetByName('Config');
      if (!sheet) return jsonResponse({ok:true, lastMessageSent:''});
      const val = sheet.getRange('B3').getValue();
      const lastMessageSent = (val instanceof Date && !isNaN(val))
        ? Utilities.formatDate(val, 'IST', 'yyyy-MM-dd')
        : String(val || '');
      return jsonResponse({ok:true, lastMessageSent});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  // ── Read Stock data (admin only) ─────────────────────────────────
  if (action === 'readStock') {
    try {
      const forceRefresh = (e && e.parameter && e.parameter.forceRefresh === '1');
      const cache  = CacheService.getScriptCache();
      const cached = (!forceRefresh) ? cache.get('stock_data_t') : null;
      if (cached) return jsonResponse({ok:true, stock: JSON.parse(cached)});

      const sheet = ss.getSheetByName(STOCK_SHEET);
      tm('stock.sheet');
      if (!sheet) return jsonResponse({ok:true, stock:{headers:[],rows:[]}});
      const b = configBounds(ss)[STOCK_SHEET];
      tm('stock.cfg');

      // Read only through column T (20 cols) and stop at the first empty cell in
      // column A. This used to be getLastRow() + a whole-column A scan + a second
      // getRange; Config bounds make it one read, and the gap test below runs on
      // what came back, so a blank row in column A still ends the table.
      const MAX_COLS = 20;
      let all;
      try {
        all = (b && b.rows > 0) ? sheet.getRange(1, 1, b.rows, MAX_COLS).getValues()
                                : sheet.getRange(1, 1, sheet.getLastRow(), MAX_COLS).getValues();
      } catch (e) {
        all = sheet.getRange(1, 1, sheet.getLastRow(), MAX_COLS).getValues();
      }
      tm('stock.values');
      if (!all.length) return jsonResponse({ok:true, stock:{headers:[],rows:[]}});
      let lastDataRow = 0;
      for (let i = 0; i < all.length; i++) {
        const a = all[i][0];
        if (a === null || a === undefined || String(a).trim() === '') break;
        lastDataRow = i + 1;
      }
      if (lastDataRow < 1) return jsonResponse({ok:true, stock:{headers:[],rows:[]}});

      const headers = all[0].map(h => String(h||'').trim());
      const dateCols = {};
      headers.forEach((h,i) => {
        const lh = String(h||'').toLowerCase();
        if (lh === 'month sold') dateCols[i] = 'm';
        else if (lh === 'order date' || lh === 'delivery date' || lh === 'selling date' || lh === 'billing date') dateCols[i] = 'd';
      });
      const rows = all.slice(1, lastDataRow).map(r => r.map((c,i) => {
        if (c instanceof Date && !isNaN(c)) {
          return dateCols[i] === 'm' ? Utilities.formatDate(c, 'IST', 'MMM yy') : fmtDate(c);
        }
        return (typeof c === 'string') ? c.trim() : c;
      }));
      const stock = { headers, rows };
      cache.put('stock_data_t', JSON.stringify(stock), 900); // 15 min TTL
      return jsonResponse({ok:true, stock});
    } catch(err){ return jsonResponse({ok:false, error:err.message}); }
  }

  return jsonResponse({ok:true, message:'AKS Finance running.'});
}

// ── GET entry point ───────────────────────────────────────────────────────
// Starts the timer and formats the object handleGet() returns. Deliberately
// takes no `opts`: there is no way to pass `internal: true` in from a request,
// so PIN verification can only be skipped when pushSnapshot() calls handleGet
// directly in the same execution.
function doGet(e) {
  tmStart();
  return jsonResponse(handleGet(e));
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

      const users = getCachedUsers(ss);
      const user = users.find(u => u.username === username && u.pin === pin);

      if (user) {
        // Success — reset failed attempts
        ScriptProperties.deleteProperty('failed_' + username);
        return jsonResponse({ok:true, user, token: createSession(user),
                             snapshotToken: mintSnapshotToken(user.id)});
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
        // Re-mint the snapshot token here: restoreSession runs on every page
        // load, so the device's snapshot access silently renews itself.
        if (userJson) {
          const u = JSON.parse(userJson);
          return jsonResponse({ok:true, user: u, snapshotToken: mintSnapshotToken(u.id)});
        }
      }
      return jsonResponse({ok:false, error:'Invalid or expired session'});
    }

    // ── Verify caller identity on every mutation ───────────────────────
    const _userId = String(payload._userId || '').trim();
    const _pin    = String(payload._pin || '').trim();
    if (!_userId || !_pin || !verifyAuth(ss, _userId, _pin)) {
      return jsonResponse({ok:false, error:'Unauthorized'});
    }

    // ── Rebuild the snapshot on demand (the "Data as of" strip) ─────────
    // The client never reads the sheet to refresh. It asks here, every sheet
    // read happens inside pushSnapshot(), and the result lands on the Worker —
    // only then does the client read anything, from the Worker. Floored so a
    // burst of clicks cannot burn the daily runtime budget; a throttled caller
    // gets an immediate ok and simply picks up whatever the Worker already has.
    if (payload.action === 'pushSnapshotNow') {
      const last = parseInt(ScriptProperties.getProperty('SNAPSHOT_LAST_PUSH') || '0', 10);
      const waited = Date.now() - last;
      if (last && waited < SNAPSHOT_PUSH_FLOOR_MS) {
        return jsonResponse({ok:true, throttled:true,
                             retryAfterMs: SNAPSHOT_PUSH_FLOOR_MS - waited});
      }
      try {
        const r = pushSnapshot();
        return jsonResponse({ok:true, epoch:r.epoch, bytes:r.bytes, sources:r.sources});
      } catch (err) {
        return jsonResponse({ok:false, error:'Snapshot push failed: ' + err.message});
      }
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
      // Lean response — client updates its local pending list itself.
      return jsonResponse({ok:true});
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
            // Read just the one needed cell instead of the whole ~93-col row.
            emiStartDate = ds.getRange(i+2, C.emiStartDate+1).getValue();
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
      // Lean response — client updates its local pending list itself.
      return jsonResponse({ok:true});
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
          // Lean response — client already holds the edited data.
          return jsonResponse({ok:true});
        }
      }
      return jsonResponse({ok:false,error:'ID not found'});
    }

    // ── Add user ────────────────────────────────────────────────────────
    if (payload.action === 'addUser') {
      const { id, username, pin, name, role, perms } = payload;
      const headers = ['ID','Username','PIN','Name','Role','loan','allLoans','approvals','submit','stock'];
      const sheet = ensureSheet(ss, USERS_SHEET, headers);
      // Map each header to its column position so the sheet layout is irrelevant
      const lastCol = sheet.getLastColumn();
      const rowHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
        .map(h => String(h || '').trim().toLowerCase());
      const nextRow = sheet.getLastRow() + 1;
      const setCell = (name, val) => {
        const i = rowHeaders.indexOf(name.toLowerCase());
        if (i !== -1) sheet.getRange(nextRow, i + 1).setValue(val);
      };
      setCell('ID', id);
      setCell('Username', username);
      setCell('PIN', pin);
      setCell('Name', name);
      setCell('Role', role);
      setCell('loan', perms.loan ? 'TRUE' : 'FALSE');
      setCell('allLoans', perms.allLoans ? 'TRUE' : 'FALSE');
      setCell('approvals', perms.approvals ? 'TRUE' : 'FALSE');
      setCell('submit', perms.submit ? 'TRUE' : 'FALSE');
      setCell('stock', perms.stock ? 'TRUE' : 'FALSE');
      // The row is written above. Anything that fails from here must not be
      // reported as a failed write — so degrade to a lean response instead.
      try { bustUsersCache(); } catch(e) {}
      let users = null;
      try { users = readAllUsers(ss); } catch(e) { users = null; }
      return jsonResponse(users ? {ok:true, users:users} : {ok:true});
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
    try { bustUsersCache(); } catch(e) {}
    let users = null;
    try { users = readAllUsers(ss); } catch(e) { users = null; }
    return jsonResponse(users ? {ok:true, users:users} : {ok:true});
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
            if (!loanRow) { deleteFromSheet(ss, sheetName, id); return jsonResponse({ok:true}); }
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

              const newRows = [];
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

                newRows.push([
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
              // One bulk write instead of one appendRow per EMI.
              if (newRows.length)
                logSheet.getRange(logSheet.getLastRow() + 1, 1, newRows.length, 12).setValues(newRows);
            }
          }
          deleteFromSheet(ss, sheetName, id);

        // ── Multiple EMI Payment: split one payment into N logged EMIs ──
        } else if (miscType.indexOf('multiple emi payment') === 0) {
          const count = parseInt((String(row[16] || '').match(/\((\d+)\)/) || [])[1]) || 2;
          const loanId = String(row[5] || '').replace(/_\d+$/, '');
          if (loanId) {
            const ds = ss.getSheetByName(DATA_SHEET);
            let loanRow = null;
            if (ds && ds.getLastRow() > 1) {
              const ids = ds.getRange(2, C.loanId+1, ds.getLastRow()-1, 1).getValues();
              for (let i=0;i<ids.length;i++) {
                if (String(ids[i][0]).trim() === loanId) {
                  loanRow = ds.getRange(i+2, 1, 1, ds.getLastColumn()).getValues()[0];
                  break;
                }
              }
            }
            const totalAmt = parseFloat(row[15]) || 0;
            const receivedDate = String(fmtDate(row[13]) || '').trim();
            if (loanRow) {
              const stdEmi = parseFloat(loanRow[C.monthlyEmi]) || 0;
              const numRcv = parseInt(loanRow[C.numReceivedEmi]) || 0;
              const dur    = parseInt(loanRow[C.emiDuration]) || 0;
              const fill   = Math.max(0, Math.min(count, dur - numRcv));
              if (fill > 0) {
                const emiStartRaw = loanRow[C.emiStartDate];
                const emiStart = (emiStartRaw instanceof Date && !isNaN(emiStartRaw))
                  ? new Date(emiStartRaw) : parseFlexDate(emiStartRaw);
                const logSheet  = ensureSheet(ss, LOGGED_EMI_SHEET,
                  ['EMI_ID','Customer Name','Mobile Model','EMI_Start_Date','EMI_Number',
                   'EMI_Date','Loan ID','Received','Received_date','MISC','Cashflow','MISC Type']);
                const newRows = [];
                for (let i = 0; i < fill; i++) {
                  const slotIdx = numRcv + i;
                  const isLast  = (i === fill - 1);
                  const cash    = isLast ? totalAmt : 0;
                  let scheduledDate = '';
                  if (emiStart) {
                    const d = new Date(emiStart);
                    d.setMonth(d.getMonth() + slotIdx);
                    scheduledDate = fmtDate(d);
                  }
                  newRows.push([
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
                    'Extra EMI received',
                  ]);
                }
                // One bulk write instead of one appendRow per EMI.
                if (newRows.length)
                  logSheet.getRange(logSheet.getLastRow() + 1, 1, newRows.length, 12).setValues(newRows);
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
          // Also remove any leftover 'approved' partial payment rows for the same EMI_ID
          const emiKey = String(row[5] || '').trim();
          if (emiKey) {
            const partialSheet = ss.getSheetByName(UNAPP_EMI_SHEET);
            const pData = partialSheet.getDataRange().getValues();
            for (let i=1; i<pData.length; i++) {
              if (String(pData[i][1]).toLowerCase()==='approved'
                && String(pData[i][16]||'').toLowerCase()==='partial payment'
                && String(pData[i][5]||'').trim() === emiKey) {
                partialSheet.deleteRow(i+1);
                break;
              }
            }
          }
        }
      }
      try { CacheService.getScriptCache().remove('loans_slim'); } catch(e) {}
      try { CacheService.getScriptCache().remove('loans_full'); } catch(e) {}
      bustLoanDataCaches(type === 'emi' ? String(row[5] || '').replace(/_\d+$/, '') : '');
      // Lean response — client removes the approved item locally.
      return jsonResponse({ok:true});
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
      // Lean response — client mirrors the row update locally.
      return jsonResponse({ok:true});
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
          // Lean response — client marks the item rejected locally.
          return jsonResponse({ok:true});
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
      // Writes are done — a failure re-reading the pending list must not turn
      // this into a reported failure.
      let pending = null;
      try { pending = readAllPending(ss); } catch(e) { pending = null; }
      return jsonResponse(pending ? {ok:true, fixed, pending:pending} : {ok:true, fixed});
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
      bustLoanDataCaches(loanId);
      // Return fresh dates in the same response — saves the follow-up
      // readRevisedDates GET. The row is already appended at this point, so a
      // failure reading the dates back must NOT be reported as a failed write:
      // that is exactly how the client ended up red-flagging a save that had
      // already succeeded. Omit the field instead and let the client fetch later.
      let dates = null;
      try { dates = readAllRevisedDates(ss); } catch(e) { dates = null; }
      return jsonResponse(dates ? {ok:true, dates:dates} : {ok:true});
    }

    // ── Set lock app removed state (loan-level toggle, upsert into LockAppStatus) ──
    if (payload.action === 'setLockRemoved') {
      const caller = getCachedUsers(ss).find(u => u.id === _userId);
      if (!caller || caller.role !== 'admin') return jsonResponse({ok:false, error:'Admin only'});
      const loanId = String(payload.loanId || '').trim();
      if (!loanId) return jsonResponse({ok:false, error:'Missing loanId'});

      // Verify loan exists in Data and is a Mobile device (read-only scan)
      const ds = ss.getSheetByName(DATA_SHEET);
      let deviceType = '';
      if (ds && ds.getLastRow() > 1) {
        const ids = ds.getRange(2, C.loanId+1, ds.getLastRow()-1, 1).getValues();
        for (let i=0; i<ids.length; i++) {
          if (String(ids[i][0]).trim() === loanId) {
            deviceType = String(ds.getRange(i+2, C.deviceType+1).getValue() || '').trim();
            break;
          }
        }
      }
      if (!deviceType) return jsonResponse({ok:false, error:'Loan not found'});
      if (deviceType.toLowerCase() !== 'mobile') return jsonResponse({ok:false, error:'Not a Mobile device'});

      const sheet = ensureSheet(ss, LOCK_STATUS_SHEET, ['LoanID','Removed','RemovedAt']);
      const now = new Date().toISOString();
      const removed = payload.removed === undefined ? true : payload.removed === true || payload.removed === 'true';
      let rowNum = 0;
      if (sheet.getLastRow() > 1) {
        const ids = sheet.getRange(2, 1, sheet.getLastRow()-1, 1).getValues();
        for (let i=0; i<ids.length; i++) {
          if (String(ids[i][0]).trim() === loanId) { rowNum = i + 2; break; }
        }
      }
      if (rowNum > 0) {
        sheet.getRange(rowNum, 2).setValue(removed);
        sheet.getRange(rowNum, 3).setValue(removed ? now : '');
      } else {
        sheet.appendRow([loanId, removed, removed ? now : '']);
      }
      try { CacheService.getScriptCache().remove('loans_slim'); } catch(e) {}
      try { CacheService.getScriptCache().remove('loans_full'); } catch(e) {}
      bustLoanDataCaches(loanId);
      return jsonResponse({ok:true});
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

// ── Read every revised date (shared by GET readRevisedDates and setRevisedDate) ──
// TOP-LEVEL helper — must live outside doGet/doPost so both handlers can call it.
function readLockStatus(ss) {
  const sheet = ss.getSheetByName(LOCK_STATUS_SHEET);
  if (!sheet) return {};
  const rows = readDataRows(sheet, 2, configBounds(ss)[LOCK_STATUS_SHEET], 2, 'lock.');
  const map = {};
  rows.forEach(r => {
    const lid = String(r[0]||'').trim();
    if (lid && r[1] === true) map[lid] = true;
  });
  return map;
}

function readAllRevisedDates(ss) {
  const sheet = ss.getSheetByName(REVISED_DATES_SHEET);
  tm('rev.sheet');
  if (!sheet) return [];
  const b = configBounds(ss)[REVISED_DATES_SHEET];
  tm('rev.cfg');
  const rows = readDataRows(sheet, 2, b, 6, 'rev.');
  return rows.filter(r => r[0] && String(r[0]).trim()).map(r => ({
    loanId: String(r[0]||'').trim(),
    emiNum: parseInt(r[1])||0,
    revisedDate: fmtDate(r[2]),
    amount: parseFloat(r[3])||0,
    note: String(r[4]||'').trim(),
    createdAt: String(r[5]||''),
  }));
}

// ── Cached helpers for per-loan detail reads (readLoanDetail) ─────────────
// readLoanDetail runs once per card click while the client is in slim mode.
// The lock-status, logged-EMI and revised-date sheets are the same for every
// loan, so they are cached for 5 min instead of being re-read per click.
const DETAIL_CACHE_TTL = 300;

// The logged-EMI sheet is re-read by every 10-minute snapshot push, via
// buildFullLoan() -> applyMiscTypes() -> getCachedEmiLogByLoan(). A 300 s
// lifetime was therefore guaranteed to have expired before the next push
// arrived, so the full ~850 ms read ran every single time. Every write path
// already calls bustLoanDataCaches(), which removes this key outright, so a
// longer life can only ever serve data that has not been touched.
const EMI_LOG_CACHE_TTL = 900;

function loanDetailCacheKey(loanId) {
  return 'loan_dtl_' + String(loanId || '').replace(/[^A-Za-z0-9_-]/g, '_');
}

// Drops the per-loan detail cache plus every shared sheet cache it was built
// from. Called from all write paths so a mutated loan is never served stale.
function bustLoanDataCaches(loanId) {
  try { CacheService.getScriptCache().remove(loanDetailCacheKey(loanId)); } catch(e) {}
  try { CacheService.getScriptCache().remove('lock_status_map'); } catch(e) {}
  try { CacheService.getScriptCache().remove('emi_log_byloan'); } catch(e) {}
  try { CacheService.getScriptCache().remove('revised_dates_raw'); } catch(e) {}
}

function cachePutIfSmall(cache, key, value, ttl) {
  try {
    const str = JSON.stringify(value);
    if (str.length <= 95000) cache.put(key, str, ttl);
  } catch(e) { /* non-critical */ }
}

// Lock-app-removed map, cached.
function getCachedLockStatusMap(ss) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('lock_status_map');
  if (hit) { try { return JSON.parse(hit); } catch(e) { /* re-read */ } }
  const map = readLockStatus(ss);
  cachePutIfSmall(cache, 'lock_status_map', map, DETAIL_CACHE_TTL);
  return map;
}

// Logged-EMI rows grouped by base loanId (the _<n> suffix stripped), cached.
function getCachedEmiLogByLoan(ss) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('emi_log_byloan');
  if (hit) { try { return JSON.parse(hit); } catch(e) { /* re-read */ } }
  const byLoan = {};
  try {
    const logSheet = ss.getSheetByName(LOGGED_EMI_SHEET);
    if (logSheet) {
      const logData = readDataRows(logSheet, 2, configBounds(ss)[LOGGED_EMI_SHEET], 12, 'emilog.');
      logData.forEach(r => {
        const lid = String(r[0]||'').replace(/_\d+$/, '');
        if (!byLoan[lid]) byLoan[lid] = [];
        byLoan[lid].push(r);
      });
    }
  } catch(e) { /* non-critical */ }
  cachePutIfSmall(cache, 'emi_log_byloan', byLoan, EMI_LOG_CACHE_TTL);
  return byLoan;
}

// Copies miscType from the logged-EMI rows onto the matching slots of a loan.
function applyMiscTypes(loan, byLoan) {
  const rows = byLoan && byLoan[loan.loanId];
  if (!rows || !loan.slots) return;
  rows.forEach(r => {
    const emiNum = parseInt(r[4]);
    const mt = String(r[11]||'').trim();
    if (!mt) return;
    const slot = loan.slots.find(s => s.num === emiNum);
    if (slot) slot.miscType = mt;
  });
}

// Revised dates for one loan — raw sheet cached, filtered in memory.
function getCachedRevisedDatesFor(ss, loanId) {
  const cache = CacheService.getScriptCache();
  let rows = null;
  const hit = cache.get('revised_dates_raw');
  if (hit) { try { rows = JSON.parse(hit); } catch(e) { rows = null; } }
  if (!rows) {
    rows = [];
    try {
      const revSheet = ss.getSheetByName(REVISED_DATES_SHEET);
      if (revSheet && revSheet.getLastRow() > 1) {
        rows = revSheet.getRange(2, 1, revSheet.getLastRow()-1, 6).getValues().map(r => [
          String(r[0]||'').trim(),
          parseInt(r[1])||0,
          fmtDate(r[2]),
          parseFloat(r[3])||0,
          String(r[4]||'').trim(),
          String(r[5]||''),
        ]);
      }
    } catch(e) { /* non-critical */ }
    cachePutIfSmall(cache, 'revised_dates_raw', rows, DETAIL_CACHE_TTL);
  }
  return rows.filter(r => r[0] === String(loanId)).map(r => ({
    emiNum: r[1], revisedDate: r[2], amount: r[3], note: r[4], createdAt: r[5],
  }));
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
  // Per-sheet marks: getLastRow/getLastColumn are SERVER round-trips and this
  // function was making four of them for what is usually a tiny sheet. Config
  // bounds collapse all four into one getRange(); `Unapproved_Loan.cfg` shows
  // the one-off Config read and a `lastRow` mark means Config had no entry and
  // the old round-trips were used instead.
  const p = sheetName + '.';
  const sheet = ss.getSheetByName(sheetName);
  tm(p + 'sheet');
  if (!sheet) return [];
  const b = configBounds(ss)[sheetName];
  tm(p + 'cfg');
  const rows = readDataRows(sheet, 2, b, type === 'loan' ? 21 : 17, p);
  const out = rows
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
  tm(p + 'map');
  return out;
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
  sheet.getRangeList(['D' + r, 'M' + r]).setNumberFormat('@');
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
  if (!sheet || sheet.getLastRow() < 2) return;
  const vals = sheet.getDataRange().getValues();
  // Group contiguous matching rows so each run is a single deleteRows call
  // (per-row deleteRow is very slow on large sheets).
  const runs = [];
  for (let i = vals.length - 1; i >= 1; i--) {
    if (String(vals[i][0]) === String(id)) {
      const row = i + 1;
      if (runs.length && runs[0].start === row + runs[0].len) runs[0].start = row;
      else runs.unshift({ start: row, len: 1 });
    }
  }
  runs.forEach(r => sheet.deleteRows(r.start, r.len));
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
  const DEFAULT_ADMIN = [{ id:'u1', username:'AKS', pin:'0000', name:'AKS (You)', role:'admin',
    perms:{ loan:true, allLoans:true, approvals:true, submit:true, stock:true } }];
  const sheet = ss.getSheetByName(USERS_SHEET);
  if (!sheet) return DEFAULT_ADMIN;
  // Header + every data row in ONE read. This used to be getLastRow(),
  // getLastColumn(), a header getValues(), getLastRow() again, then a data
  // getValues() - five separate round-trips on a tab that a single push reads
  // twice (here, and again through usersFingerprint). minCols=10 is the widest
  // of the columns the mapping below looks for, so an under-counting Config
  // cannot make col() report -1 for a column that really is there.
  const all = readDataRows(sheet, 1, configBounds(ss)[USERS_SHEET], 10, 'users.');
  if (all.length < 2) return DEFAULT_ADMIN;
  const headers = all[0].map(h => String(h || '').trim().toLowerCase());
  const col = name => {
    const i = headers.indexOf(name);
    return i === -1 ? -1 : i;
  };
  const ci = { id:col('id'), username:col('username'), pin:col('pin'), name:col('name'), role:col('role'),
    loan:col('loan'), allLoans:col('allloans'), approvals:col('approvals'), submit:col('submit'), stock:col('stock') };
  const read = (r, key, def) => ci[key] >= 0 ? String(r[ci[key]] || '').trim() : def;
  const readBool = (r, key) => read(r, key, '').toUpperCase() === 'TRUE';

  const raw = all.slice(1);
  const users = raw.filter(r => r[0] && String(r[0]).trim()).map(r => ({
    id: read(r, 'id', String(r[0]).trim()),
    username: read(r, 'username'),
    pin: read(r, 'pin'),
    name: read(r, 'name'),
    role: read(r, 'role'),
    perms: {
      loan:      readBool(r, 'loan'),
      allLoans:  readBool(r, 'allLoans'),
      approvals: readBool(r, 'approvals'),
      submit:    readBool(r, 'submit'),
      stock:     readBool(r, 'stock'),
    },
  }));
  // Ensure default admin is always present (even if not in the sheet)
  if (!users.some(u => u.id === 'u1')) {
    users.unshift({ id:'u1', username:'AKS', pin:'0000', name:'AKS (You)', role:'admin',
      perms:{ loan:true, allLoans:true, approvals:true, submit:true, stock:true } });
  }
  return users;
}

// Public version — no PINs exposed (used by GET readUsers)
function readAllUsersPublic(ss) {
  return getCachedUsers(ss).map(({ pin, ...u }) => u);
}

// ── Cached user list — avoids a full Users-sheet read on EVERY request ────
// TTL 300 s. Bust with bustUsersCache() whenever users are added/removed.
// Note: edits made directly in the Users sheet take up to 5 min to be seen.
function getCachedUsers(ss) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('users_cache');
  if (cached) {
    try { return JSON.parse(cached); } catch(e) { /* fall through */ }
  }
  const users = readAllUsers(ss);
  try {
    const str = JSON.stringify(users);
    if (str.length <= 95000) cache.put('users_cache', str, 300);
  } catch(e) {}
  return users;
}

function bustUsersCache() {
  try { CacheService.getScriptCache().remove('users_cache'); } catch(e) {}
}

function verifyAuth(ss, userId, pin) {
  const users = getCachedUsers(ss);
  return users.some(u => u.id === userId && u.pin === pin);
}

// Create a session token for a logged-in user
function createSession(user) {
  const token = Utilities.getUuid();
  ScriptProperties.setProperty('session_' + token, JSON.stringify(user));
  return token;
}

// ── SNAPSHOT (Path B) ───────────────────────────────────────────────────────
// A 5-minute time-driven trigger runs pushSnapshot(), which rebuilds every read
// payload by calling handleGet() directly — literally the same code the API
// serves, so the snapshot can never drift from it — and POSTs the result to the
// Cloudflare Worker. The browser then paints in ~0.3 s instead of paying Apps
// Script's front-end (measured 2.0 s warm, 9.1 s cold) on every single load.

// 30 days. Renewed on every login and every restoreSession, so a device only
// re-enters its PIN if you change it, delete the user, or leave it alone a month.
const SNAPSHOT_TOKEN_TTL = 30 * 24 * 60 * 60;

// Floor on user-triggered pushes. The strip refresh runs pushSnapshot(), which
// costs ~15 s of the 5400 s/day Apps Script budget; without a floor, mashing
// the button — or ten people doing it at once — could spend the whole day's
// allowance in a few minutes. The 10-minute timer sits far above this and is
// never affected.
const SNAPSHOT_PUSH_FLOOR_MS = 30000;

// Add a sheet here and its payload joins the snapshot — one line, nothing else.
// `action` must be a handleGet action; `out` is the key that action returns.
const SNAPSHOT_SOURCES = [
  // No `loans_slim`: readAllLoans already reads every one of these rows across
  // all 93 columns, and the slim fallback in applySnapshot() can never fire —
  // if readAllLoans failed, pushSnapshot() throws and no snapshot is published
  // at all. Re-reading 49 of the same 93 columns cost ~4 s of every push.
  { key: 'loans',        action: 'readAllLoans',         out: 'loans' },
  { key: 'revisedDates', action: 'readRevisedDates',     out: 'dates' },
  { key: 'pending',      action: 'readPending',          out: 'pending' },
  { key: 'partials',     action: 'readApprovedPartials', out: 'partials' },
  { key: 'users',        action: 'readUsers',            out: 'users' },
  { key: 'stock',        action: 'readStock',            out: 'stock', params: { forceRefresh: '1' } },
  { key: 'config',       action: 'readConfig',           out: 'lastMessageSent' },
  { key: 'templates',    action: 'readMessageTemplates', out: 'templates' },
];
// readAllLoansForMsgs is served from `loans`: buildFullLoan() already carries
// welcomeMsgText/emiMsgText/lastDateMsgText/thankYouMsgText/loanClosingMsgText/
// revisedDateMsg, so a second read would only duplicate it.

function hex2(b) {
  const n = b < 0 ? b + 256 : b;
  return (n < 16 ? '0' : '') + n.toString(16);
}
function hmacSha256Hex(secret, message) {
  return Utilities.computeHmacSha256Signature(message, secret, Utilities.Charset.UTF_8)
    .map(hex2).join('');
}

// Token: <userId>.<expiresAt>.<epoch>.<hmac>. Parsed from the right so a userId
// containing dots cannot shift the fields.
function mintSnapshotToken(userId) {
  try {
    const secret = ScriptProperties.getProperty('SNAPSHOT_SECRET');
    if (!secret || !userId) return '';
    const epoch = String(ScriptProperties.getProperty('SNAPSHOT_EPOCH') || '0');
    const exp   = Math.floor(Date.now() / 1000) + SNAPSHOT_TOKEN_TTL;
    const body  = String(userId) + '.' + exp + '.' + epoch;
    return body + '.' + hmacSha256Hex(secret, body);
  } catch (e) { return ''; }
}

// Hashes the Users sheet INCLUDING PINs, but only ever stores the digest.
// The sheet is edited directly (no Apps Script hook fires on a PIN change), so
// this is what catches it: pushSnapshot() runs every 5 minutes, compares the
// digest, and bumps the epoch — killing every outstanding token.
function usersFingerprint(ss) {
  const canonical = readAllUsers(ss).map(u => [
    u.id, u.username, u.pin, u.role,
    u.perms ? [u.perms.loan, u.perms.allLoans, u.perms.approvals,
               u.perms.submit, u.perms.stock].join(',') : ''
  ].join('\u0001')).join('\u0002');
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
                                 canonical, Utilities.Charset.UTF_8)
    .map(hex2).join('');
}

// ── pushSnapshot profiling ────────────────────────────────────────────────
// doPost never calls tmStart(), so the marks handleGet already emits (open,
// auth, read, build, str …) are no-ops during a push — that is why only the
// total was ever visible. We start and stop a timer around EACH source and key
// it by action name, so the eight sources cannot overwrite one another, and the
// inner marks come back nested under their own action.

// Byte length of a value, or null if it is not serialisable. Only called when
// the caller asked for byte counts (one extra stringify per source).
function byteLen(v) {
  try { return JSON.stringify(v).length; } catch (e) { return null; }
}

// The single call site that passes internal:true. Reads every snapshot source
// through handleGet() — i.e. exactly the code path the API itself serves — and
// records `{ ms, marks, bytes }` per action into `timings`. snapshot-test
// enforces that this appears exactly once in the file, so do not repeat the
// literal opts object in any comment.
function runSnapshotSources(timings, measureBytes) {
  const data = {};
  SNAPSHOT_SOURCES.forEach(src => {
    const t0 = Date.now();
    tmStart();
    let resp = null, failure = null;
    try {
      resp = handleGet(
        { parameter: Object.assign({ action: src.action }, src.params || {}) },
        { internal: true }
      );
    } catch (e) {
      failure = e;
    }
    const marks = tmEnd() || {};
    const ms = Date.now() - t0;
    if (failure) throw failure;
    if (!resp || resp.ok !== true) {
      throw new Error(src.action + ' failed: ' + ((resp && resp.error) || 'unknown'));
    }
    data[src.key] = resp[src.out];
    timings[src.action] = {
      ms: ms,
      marks: marks,
      bytes: measureBytes ? byteLen(resp[src.out]) : null,
    };
  });
  return data;
}

// Safe logger for the profile. Logger is the canonical Apps Script API and
// exists on every runtime (V8 and legacy); console is the fallback. Neither
// branch may ever throw — reporting must not be able to break a push, and a
// failure inside the catch block would hide the real error from the log.
function profLog(msg) {
  try { Logger.log(msg); return; } catch (e) {}
  try { console.log(msg); } catch (e2) {}
}

// Prints the action-wise breakdown. Shows up both when you run
// profilePushSnapshot() from the editor and in the Executions log for a
// trigger-driven push.
function logPushProfile(timings, opts) {
  try {
    const names = Object.keys(timings).filter(function (k) {
      return k.charAt(0) !== '_' || k === '__error';
    });
    const total = timings.__total || 0;

    const rows = names.filter(function (k) { return typeof timings[k] === 'object'; })
      .map(function (k) {
        return { k: k, ms: timings[k].ms, bytes: timings[k].bytes };
      })
      .sort(function (a, b) { return b.ms - a.ms; });

    const fixed = Object.keys(timings).filter(function (k) {
      // __total is the header, __error is text, __workerHttp is a status code
      // (already printed there), and __rawBytes/__zipBytes are sizes, not costs.
      // Only real millisecond costs belong in this section.
      return k.charAt(0) === '_' && k !== '__total' && k !== '__error' &&
             k !== '__workerHttp' && k !== '__rawBytes' && k !== '__zipBytes' &&
             typeof timings[k] === 'number';
    }).sort(function (a, b) { return timings[b] - timings[a]; });

    const pct = function (ms) {
      return total ? Math.round((ms / total) * 100) + '%' : '—';
    };
    const pad = function (s, n) { s = String(s); while (s.length < n) s += ' '; return s; };
    const kb = function (n) {
      if (n === null || n === undefined) return '';
      if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
      if (n >= 1024)    return Math.round(n / 1024) + ' KB';
      return n + ' B';
    };
    const ms = function (n) { return n.toLocaleString('en-US') + ' ms'; };

    const lines = [];
    lines.push('');
    lines.push('=== pushSnapshot profile  ' + new Date().toISOString().slice(0, 19).replace('T', ' ') +
               (opts && opts.profile ? '  [profile]' : '') + ' ===');
    lines.push(pad('total', 24) + pad(ms(total), 14) + pad('100%', 7) +
               (timings.__workerHttp !== undefined ? 'HTTP ' + timings.__workerHttp : ''));
    if (timings.__error) lines.push('FAILED: ' + timings.__error);

    rows.forEach(function (r) {
      lines.push('  ' + pad(r.k, 22) + pad(ms(r.ms), 14) + pad(pct(r.ms), 7) +
                 pad(kb(r.bytes), 9));
    });

    if (fixed.length) {
      lines.push('  -- fixed --');
      fixed.forEach(function (k) {
        lines.push('  ' + pad(k.replace(/^__/, ''), 22) + pad(ms(timings[k]), 14) +
                   pad(pct(timings[k]), 7));
      });
    }
    if (timings.__rawBytes !== undefined && timings.__zipBytes !== undefined) {
      let pl = '  payload sent ' + kb(timings.__zipBytes);
      if (timings.__rawBytes) {
        pl += ', ' + kb(timings.__rawBytes) + ' uncompressed';
        if (timings.__zipBytes < timings.__rawBytes) {
          pl += ' (' + Math.round((1 - timings.__zipBytes / timings.__rawBytes) * 100) + '% smaller)';
        }
      }
      lines.push(pl);
    }
    if (opts && opts.profile && timings.__stringify !== undefined) {
      lines.push('  (byte counts cost ' + ms(timings.__stringify) + ' extra — profile only)');
    }
    lines.push('');
    profLog(lines.join('\n'));
  } catch (e) {
    // Never let a reporting problem fail the push itself.
    profLog('pushSnapshot profile unavailable: ' + e);
  }
}

// Runs on the trigger. Throws on failure so the Apps Script error log records it.
//
// The profile is printed ONLY for an explicit profile run. The 10-minute
// trigger and pushSnapshotNow take the same code path as the original
// pushSnapshot and log nothing — timing is still collected (a handful of
// Date.now() calls) but never rendered, so the production path cannot be
// broken by a reporting problem.
function pushSnapshot(opts) {
  const timings = {};
  const t0 = Date.now();
  const profile = !!(opts && opts.profile);
  try {
    const r = pushSnapshotBody(timings, opts);
    timings.__total = Date.now() - t0;
    if (profile) logPushProfile(timings, opts);
    return r;
  } catch (e) {
    timings.__error = String((e && e.message) || e);
    timings.__total = Date.now() - t0;
    if (profile) logPushProfile(timings, opts);
    throw e;
  }
}

function pushSnapshotBody(timings, opts) {
  const measure = !!(opts && opts.profile);

  const props = ScriptProperties;
  const secret = props.getProperty('SNAPSHOT_SECRET');
  const url    = props.getProperty('SNAPSHOT_WORKER_URL');
  if (!url)    throw new Error('SNAPSHOT_WORKER_URL is not set — run configureSnapshot(url) once.');
  if (!secret) throw new Error('SNAPSHOT_SECRET is not set — run configureSnapshot(url) once.');

  // Stamped BEFORE the work starts, so a second caller arriving mid-push is
  // refused instead of paying for a duplicate 15 s rebuild.
  props.setProperty('SNAPSHOT_LAST_PUSH', String(Date.now()));

  let mark = Date.now();
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  timings.__openById = Date.now() - mark;

  mark = Date.now();
  const fp = usersFingerprint(ss);
  timings.__usersFingerprint = Date.now() - mark;

  mark = Date.now();
  let epoch = parseInt(props.getProperty('SNAPSHOT_EPOCH') || '0', 10);
  if (fp !== props.getProperty('SNAPSHOT_USERS_FP')) {
    epoch++;
    props.setProperty('SNAPSHOT_EPOCH', String(epoch));
    props.setProperty('SNAPSHOT_USERS_FP', fp);
  }
  timings.__epoch = Date.now() - mark;

  const data = runSnapshotSources(timings, measure);

  // HARD RULE: `users` must be the public projection. readAllUsers() returns
  // raw PINs — the snapshot would publish every password in the sheet.
  mark = Date.now();
  const users = data.users;
  if (Array.isArray(users) && users.some(u => u && Object.prototype.hasOwnProperty.call(u, 'pin'))) {
    throw new Error('refusing to push: snapshot users payload contains a pin');
  }
  timings.__pinScan = Date.now() - mark;

  mark = Date.now();
  const body = JSON.stringify({
    v: 1,
    generatedAt: Date.now(),
    epoch: epoch,
    usersFingerprint: fp,
    data: data,
  });
  timings.__stringify = Date.now() - mark;
  timings.__rawBytes = body.length;

  // Deflate before the upload. The body is ~4.6 MB of plain JSON, and the
  // Apps Script -> Worker hop was costing ~3 s just to move those bytes.
  // Utilities.zip() wraps the JSON in a ZIP entry (deflate method), which the
  // Worker inflates and then stores as plain JSON in KV - so the read path,
  // the token path and every client are completely untouched. If zipping is
  // unavailable for any reason we send the plain JSON instead: the Worker
  // accepts both, decided by the ZIP magic bytes rather than a flag, so an old
  // Worker and a new Apps Script (or the reverse) can never disagree.
  mark = Date.now();
  let payload = body;
  let contentType = 'application/json';
  try {
    payload = Utilities.zip([Utilities.newBlob(body, 'application/json', 'snapshot.json')]);
    contentType = 'application/zip';
  } catch (zipErr) {
    payload = body;
    contentType = 'application/json';
  }
  // An Apps Script Blob exposes no `length`, so the compressed size has to come
  // from getBytes(). The plain-JSON fallback is a string, and reports its own
  // length, which keeps the profile line honest in both cases.
  const zipBytes = (payload && typeof payload.getBytes === 'function')
    ? payload.getBytes().length
    : (payload ? String(payload).length : 0);
  timings.__zip = Date.now() - mark;
  timings.__zipBytes = zipBytes;

  mark = Date.now();
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: contentType,
    headers: { Authorization: 'Bearer ' + secret },
    payload: payload,
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  timings.__workerFetch = Date.now() - mark;
  timings.__workerHttp = code;
  if (code < 200 || code >= 300) {
    throw new Error('worker rejected push: HTTP ' + code + ' ' +
                    String(res.getContentText()).slice(0, 200));
  }
  return { ok: true, epoch: epoch, bytes: body.length, sentBytes: timings.__zipBytes,
           sources: SNAPSHOT_SOURCES.length };
}

// Run from the Apps Script editor (▶ profilePushSnapshot) to see where the
// ~15 s of a push actually goes. Does EXACTLY the same work as the 10-minute
// trigger, so the numbers are representative — the only extra cost is one
// extra JSON.stringify per source, to report payload sizes.
//
// The failure is re-thrown with a `profilePushSnapshot failed -> ` prefix so
// the Executions ROW states a real reason without you having to click into the
// log. If a failed run shows no such prefix, this function never started —
// which means the script did not compile or did not save, not that a read broke.
function profilePushSnapshot() {
  profLog('profilePushSnapshot: start');
  try {
    return pushSnapshot({ profile: true });
  } catch (e) {
    const reason = (e && e.message) ? e.message : String(e);
    // pushSnapshot() has already printed its FAILED line; this adds the stack,
    // which is what actually tells you the offending line number.
    profLog('profilePushSnapshot: ' + (e && e.stack ? e.stack : e));
    const err = new Error('profilePushSnapshot failed -> ' + reason);
    if (e && e.stack) err.stack = 'profilePushSnapshot failed -> ' + reason + '\n' + e.stack;
    throw err;
  }
}

// Run ONCE from the Apps Script editor, passing the Worker URL. Idempotent:
// it prints the secret to paste into the Worker and installs the 5-min trigger.
function configureSnapshot(workerUrl) {
  const props = ScriptProperties;
  if (workerUrl) props.setProperty('SNAPSHOT_WORKER_URL', String(workerUrl).trim());
  if (!props.getProperty('SNAPSHOT_SECRET')) {
    props.setProperty('SNAPSHOT_SECRET',
      Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  }
  if (!props.getProperty('SNAPSHOT_EPOCH')) props.setProperty('SNAPSHOT_EPOCH', '0');
  createSnapshotTrigger();
  return {
    workerUrl: props.getProperty('SNAPSHOT_WORKER_URL'),
    secret:    props.getProperty('SNAPSHOT_SECRET'),  // paste into the Worker
    epoch:     props.getProperty('SNAPSHOT_EPOCH'),
  };
}

function createSnapshotTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'pushSnapshot')
    .forEach(t => ScriptApp.deleteTrigger(t));
  // everyMinutes accepts only 1, 5, 10, 15 or 30, and the trigger quota is
  // 90 minutes of execution PER DAY across all of them.
  //
  //   5 min  -> 288 runs/day. At the measured ~16 s that is 77 min, leaving
  //             only 13 min of headroom — a handful of Google's 30–60 s runs
  //             would exhaust it and pushes would stop for the rest of the day.
  //  10 min  -> 144 runs/day -> ~38 min, leaving 52 min of headroom.
  //
  // Ten minutes of staleness is invisible in practice: every page load still
  // refreshes from the Apps Script API immediately after the snapshot paints,
  // so the snapshot only decides how the screen looks during the first ~0.3 s.
  ScriptApp.newTrigger('pushSnapshot').timeBased().everyMinutes(10).create();
}

function jsonResponse(obj) {
  // Attach the per-execution timing marks. `_T` is null for doPost (no
  // tmStart), so writes are untouched.
  try { if (_T && obj && typeof obj === 'object') obj._t = tmEnd(); } catch(e) {}
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
