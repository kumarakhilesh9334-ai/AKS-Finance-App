# AKS Financing — Developer Guide

## Project structure

```
aks-financing/
├── index.html                  ← App shell + all page templates (HTML only)
├── css/
│   └── styles.css              ← All styling (colours, layout, components)
├── js/
│   ├── state.js                ← Central data store (S object) + shared helpers
│   ├── auth.js                 ← Login / logout
│   ├── nav.js                  ← Tab navigation, page switching
│   ├── loans.js                ← New loan form, calculator, submission
│   ├── emi.js                  ← Log EMI payments
│   ├── approvals.js            ← Admin approve/reject flow + card renderer
│   ├── records.js              ← All loans view + EMI history view
│   ├── users.js                ← User management (add/remove)
│   └── export.js               ← Google Sheets export logic
└── google-apps-script.js       ← Paste this into Google Apps Script (see below)
```

## How to run

Just open `index.html` in a browser — no build step, no server needed.

Demo credentials:
- **Admin:** AKS / 0000
- **Agent:** agent1 / 1111

## How to work on a specific part

| Want to change…               | Edit this file         |
|-------------------------------|------------------------|
| Colours / fonts / spacing     | `css/styles.css`       |
| Login logic                   | `js/auth.js`           |
| Navigation tabs               | `js/nav.js`            |
| New loan form fields          | `index.html` + `js/loans.js` |
| Loan calculator formula       | `js/loans.js`          |
| EMI logging                   | `js/emi.js`            |
| Approve / reject flow         | `js/approvals.js`      |
| All-loans or EMI history view | `js/records.js`        |
| User add/remove               | `js/users.js`          |
| Google Sheets export          | `js/export.js`         |
| Data model / shared helpers   | `js/state.js`          |
| Page HTML structure           | `index.html`           |

## Google Sheets export — setup

See the detailed instructions inside `google-apps-script.js`.

Short version:
1. Create a Google Spreadsheet.
2. Go to Extensions → Apps Script → paste `google-apps-script.js` contents.
3. Replace `PASTE_YOUR_SPREADSHEET_ID_HERE` with your sheet's ID.
4. Deploy as Web App (Execute as: Me, Access: Anyone).
5. Copy the Web App URL → paste into AKS app → Export tab → Save URL.
6. Click any Export button. Data goes into its own tab (Loans / EMI History / Pending Approvals).

## Data model (in-memory)

All data lives in the global `S` object in `js/state.js`:

```js
S.loans[]     // approved loans
S.emis[]      // approved EMI records
S.pending[]   // submissions awaiting approval
S.users[]     // user accounts
S.cu          // currently logged-in user
S.sheetsUrl   // saved Google Apps Script URL (persisted in localStorage)
```

> ⚠️ Data resets on page refresh. The only thing persisted to localStorage is the Google Apps Script URL.
