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
│   ├── stock.js                ← Stock tab + stock actions
│   ├── activation.js           ← "Find recent sales" UI (Stock tab)
│   └── export.js               ← Google Sheets export logic
├── activation-check/           ← Local Playwright runner behind the Stock button
├── Start Activation Checker.bat
└── google-apps-script-separate-sheets.js  ← Paste into Apps Script (see below)
```

## How to run

Just open `index.html` in a browser — no build step, no server needed.

Demo credentials:
- **Admin:** AKS / 0000
- **Agent:** agent1 / 1111

## Activation checker (Stock tab)

The Stock tab offers two admin-only ways to check whether a unit that is still
marked **Available** has been activated in the brand's system. Both are for
spotting a recent unrecorded sale.

### Manual, row by row

Every Available unit now has two extra buttons:

- **Check** copies that row's `IMEI_1` and opens the brand's own activation page
  in a new tab. Paste the IMEI there, solve the captcha, and read the
  activation date the page shows.
- **Add date** (shown as **Edit date** once a date exists) asks for that date
  and writes it to the Stock sheet's **Activation date** column — the old
  `Settled` column, column R.

Any Available row whose **Activation date** is filled is tinted **amber** in the
Stock tab, so a unit that is activated but still not marked sold is impossible
to miss.

Activation pages are configured in `_STOCK_ACTIVATION_SITES` in `js/stock.js`:

| Brand | Page |
|---|---|
| Nothing | `in.nothing.tech/pages/imei` |
| OPPO | `support.oppo.com/in/check/` |
| iQOO | `iqoo.com/in/support/IMEI` |
| vivo | `vivo.com/en/support/IMEI` |
| Motorola / Moto | `en-in.support.motorola.com/app/warranty/check` |
| Xiaomi / Redmi / Mi | `mi.com/global/verify/#/en/tab/imei` |
| realme | `realme.com/in/support/phonecheck` |
| OnePlus | `service.oneplus.com/in/check#/` |

Any other brand still copies the IMEI and shows a warning that no page is
saved yet; add another entry to the list when you have the URL.

Saving the date needs the `markStockActivation` action, so after this change
paste the latest `google-apps-script-separate-sheets.js` into Apps Script and
create a **new deployment version**. Until that is done, **Add date** reports
`Unknown action: markStockActivation`. Edit the **existing** deployment rather
than creating a new one, so the `/exec` URL in `js/state.js` does not change.

### Batch check

The admin-only **Find recent sales** button asks each brand's IMEI portal
whether a unit has been activated and returns one CSV download; the Stock sheet
is never written to by this path.

The app is static, so it cannot open a browser by itself. A small local Node.js
server does that part:

1. Install [Node.js LTS](https://nodejs.org) once.
2. Double-click **Start Activation Checker.bat** in the app folder.
   The first run installs Playwright and Chromium (about 300 MB) and may take a
   few minutes. Later runs are instant.
3. The checker opens the app at `http://127.0.0.1:8787/`. Leave the black
   window open while checking.
4. Go to **Stock → Find recent sales → Check now**.
5. The batch starts with the **last Stock row first**, so the newest units get
   checked while you are still at the keyboard. Nothing asks for a captcha
   **for every IMEI**: the Chromium window title starts with
   `⚠ Solve the captcha N/M — <IMEI>` and the app shows
   `Captcha N of M — solve it for <IMEI> in the Chromium window.`
   Nothing is drawn over the page, so the challenge is never covered. The
   checker clicks the IMEI field for you, which is the trusted click Google
   needs; solve the challenge that appears, then the next IMEI starts
   automatically. Each unit has **180 seconds** to get a token and **one
   attempt** — if you miss a challenge, that unit is marked `ERROR` and the
   batch moves on instead of stalling. Run the check again to retry it.
6. Press **Download CSV** when the run finishes.

Only units that are still **Available** (they have an `IMEI_1` and no
`Selling Date`) and whose **Device is Mobile** are checked. Brands without an
adapter are left out of the batch entirely, so today the run contains Nothing
phones only. The CSV puts activated units first, newest activation date first,
and flags every activated unit with:

> Activated but still marked Available in Stock — likely an unrecorded sale.

Reports are also saved on the computer in `activation-check/reports/`.

### Supported brands

Currently only **Nothing** (phones bought from Nothing India) has an adapter.
Only Mobile units from a supported brand are sent to the checker; everything
else is shown in the summary as "not checked" and never reaches the CSV.

To add a brand, copy `activation-check/brands/_template.js` to
`activation-check/brands/<brand>.js`, fill in the portal steps and register it
in `activation-check/brands/index.js`. The Stock tab picks it up automatically.

### Captcha and retry tuning

The checker does not retry a row by default, because a missed captcha would
otherwise cost another full wait. Three environment variables override that:

| Variable | Default | Meaning |
|---|---|---|
| `AKS_CAPTCHA_TIMEOUT_MS` | `180000` | How long one row waits for a captcha solve |
| `AKS_MAX_ATTEMPTS` | `1` | Attempts per IMEI |
| `AKS_REVERSE_ORDER` | `1` | Check the last Stock row first; set `0` for sheet order |

Set them in `activation-check/start.bat` (before `node server.js`) if a brand
needs more patience.

> The checker binds to `127.0.0.1` only. If you run it on the shop PC and want
> to use it from another device, the app must be opened from the same PC (or
> through a private tunnel such as Tailscale). An HTTPS page cannot call a
> plain-HTTP address on your local network.

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
| Stock tab / stock actions     | `js/stock.js`          |
| Activation check UI           | `js/activation.js`     |
| IMEI checking / new brand     | `activation-check/brands/` |
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
