# AKS Financing — Developer Guide

## Project structure

```
aks-financing/
├── index.html                  ← App shell + all page templates (HTML only)
├── css/
│   └── styles.css              ← All styling (colours, layout, components)
├── js/
│   ├── state.js                ← Central data store (S object) + shared helpers
│   ├── version.js              ← APP_VERSION + the Version info dialog
│   ├── snapshot.js             ← Snapshot fetch/apply + "Data as of" strip
│   ├── auth.js                 ← Login / logout
│   ├── nav.js                  ← Tab navigation, page switching
│   ├── loans.js                ← New loan form, calculator, submission
│   ├── emi.js                  ← Log EMI payments + All Loans overview
│   ├── approvals.js            ← Admin approve/reject flow + card renderer
│   ├── my-subs.js              ← "My Subs" page
│   ├── emi-messages.js         ← EMI reminder messages + UPI QR
│   └── stock.js                ← Stock tab + stock actions
├── assets/
│   └── upi-qr.png              ← UPI QR used by EMI messages
├── sw.js                       ← Service worker (offline cache)
├── manifest.json               ← PWA manifest (icon, standalone display)
├── worker.js                   ← Cloudflare Worker that serves snapshot.json
├── .gitattributes              ← Keeps repo files LF, batch files CRLF
├── google-apps-script-separate-sheets.js  ← Paste into Apps Script (see below)
└── Archive/                    ← Historical backups, not loaded by the app
    └── Redundant/              ← Retired checker, old JS modules, LAN server .bat
```

## How to run

Just open `index.html` in a browser — no build step, no server needed.

Sign-in is checked against the **Users** sheet, and there are no built-in
accounts, so the first thing to do is add an admin row (below).

## Adding an admin in the Users sheet

The app has no user-management screen; the spreadsheet *is* the user list. In the
spreadsheet set by `SPREADSHEET_ID`, open the **Users** sheet (create it if it is
missing) and make row 1 exactly these headers:

| ID | Username | PIN | Name | Role | loan | allLoans | approvals | submit | stock |
|----|----------|-----|------|------|------|----------|-----------|--------|-------|

Then add the admin as a new row:

| ID | Username | PIN | Name | Role | loan | allLoans | approvals | submit | stock |
|----|----------|-----|------|------|------|----------|-----------|--------|-------|
| u1 | yourname | 1234 | Your Name | admin | TRUE | TRUE | TRUE | TRUE | TRUE |

Rules that matter:

- **ID** must be unique and non-empty.
- **Username** and **PIN** are exactly what you type on the sign-in screen
  (case sensitive).
- **Role** is `admin` or `agent`. Only `admin` gets Approvals, EMI Msgs and
  Stock, and only `admin` can edit stock.
- The five permission columns (`loan`, `allLoans`, `approvals`, `submit`,
  `stock`) are read as `TRUE` (case insensitive) or anything else for false.
  An admin reaches every tab through the role anyway, so `TRUE` everywhere is
  the safe choice for the admin row.
- **Format the PIN column as Plain text** before typing (Format → Number →
  Plain text). A numeric cell turns `0000` into `0`, and that PIN will then
  never match. In a numeric cell, type `'0000` to keep the leading zero.
- Sheet edits are picked up within 5 minutes — the user list is cached for
  300 s. No redeploy is needed.

> An empty or missing Users sheet means **nobody can sign in**. Add the admin
> row *before* deploying this Apps Script version.

> The old Users tab was also the only place with an **Unblock** button. A user
> who fails 5 PIN attempts is blocked in Apps Script's Script Properties; open
> Apps Script → Project Settings → Script properties and delete
> `blocked_<username>` to unblock them.

## Testing on the tablet without deploying

The tablet only sees whatever is at the URL it was installed from, so a change
has to be served from *some* address it can reach. Git is just one way to get
files onto an address; none of the options below touch the repo.

### 1. HTTPS tunnel — tests the real installed-app behaviour

An installed PWA needs `https://` (or `localhost`). A temporary tunnel gives you
that without any hosting account:

```
python -m http.server 8080 --bind 127.0.0.1 --directory "C:\path\to\AK&S Finance App"
cloudflared tunnel --url http://localhost:8080
```

(Download the standalone `cloudflared-windows-amd64.exe` from the Cloudflare
GitHub releases page — a single file, no installer.)

Open the printed `https://….trycloudflare.com` URL on the tablet and use
**Install app** / *Add to Home screen*. That is a genuine WebAPK, so it behaves
like the deployed app, service worker included. Two caveats: the URL changes
every time cloudflared restarts, and the install is a separate origin from the
deployed app (new icon, fresh `localStorage`, so you have to log in again).

### 2. `adb reverse` over USB — HTTPS-free secure context

With Android platform-tools installed (a zip, no admin rights needed) and USB
debugging on, start a local server from the app folder (in another window):

```
python -m http.server 8080 --bind 127.0.0.1 --directory "C:\path\to\AK&S Finance App"
adb reverse tcp:8080 tcp:8080
```

Then open `http://localhost:8080/` on the tablet. `localhost` counts as a secure
context, so the service worker registers and Chrome will install it — the
installed-app behaviour can be tested with no hosting at all.

### 3. Direct upload, if a real deploy is acceptable

If the current host is Cloudflare Pages, its **direct upload** flow (dashboard →
*Create application* → *Pages* → *Upload assets*) accepts a folder and needs no
git. Drag-and-drop hosts such as Netlify Drop work the same way. This produces a
stable HTTPS URL, but it is still a deploy to a new origin, so the app must be
installed again there.

## Line endings and git

GitHub Desktop may warn:

> This file uses 'LF' line endings, but Git is configured to convert them to
> 'CRLF' the next time the file is checked out.

It is a warning, not an error — the commit still goes through, and the bytes
stored in the repo stay LF. It appears because Git for Windows installs with
`core.autocrlf=true` (in `C:/Program Files/Git/etc/gitconfig`), which rewrites
checked-out files to CRLF. CSS, JS and HTML do not care which one they get, so
the warning is cosmetic; the deployed site is unaffected because the stored
blobs are already LF.

`.gitattributes` in the project root removes the warning for good:

```
* text=auto eol=lf
*.bat text eol=crlf
*.png binary  /  *.jpg binary  …
```

So text files are stored *and* checked out as LF, while `.bat` files stay CRLF
(cmd.exe can mis-parse LF-only batch files that contain labels or multi-line
blocks). To apply it to an existing clone, once, from the repo folder:

```
git add .gitattributes
git add --renormalize .
git commit -m "Normalize line endings"
```

If every file shows as modified after `--renormalize`, that is expected — it is
the one-off commit that records the normalised state. After that, edits show up
as normal line diffs.

Alternatives if you would rather not add the file: run
`git config core.autocrlf false` inside that repo, or tick *Don't show this
again* in the GitHub Desktop warning.

## Text encoding (read before editing files by script)

Every source file here is UTF-8 without a BOM, and several rely on that: the
search icon (🔍), ✕ / ▶ / ▼, the `—` and `─` separators, `₹`, and `…`. Windows
PowerShell 5.1 defaults to the ANSI code page (Windows-1252 on this machine), so

```powershell
$t = Get-Content -Raw file.html     # decodes UTF-8 bytes as Windows-1252
Set-Content file.html $t            # writes them back as Windows-1252
```

silently re-encodes every one of those characters; the app then shows Latin-1
junk in place of the search icon instead of 🔍. It is lossless (it can be
reversed) but it *looks* wrecked, and one round-trip per edit compounds it.

Use a UTF-8-safe path instead:

- the editor's find/replace, or any editor that preserves encoding;
- PowerShell with explicit encoding:
  `[IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))`
  after `[IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)`.

v1.2.1 exists only because v1.2.0's `index.html`, `js/version.js` and `README.md`
went through that round-trip more than once. The pre-repair copies are kept in
`Archive/encoding-backup/`, and the header version pill plus the **Loaded files**
row in *Version info* are the quickest way to prove which build a device has.

## App version

The header shows a small pill such as **v1.4.0** next to **Sign out**. Tap it for
*Version info*: app version, release date, the files this device actually loaded
and the service-worker cache it is using. **Copy details** puts that block on the
clipboard for support.

There are three separate numbers, and only the first one is the app version:

| Where | Example | Meaning | How it changes |
|---|---|---|---|
| `APP_VERSION` in `js/version.js` | `1.4.0` | The version the header shows | Bumped by hand for a release |
| `?v=N` on `<script>` / `<link>` tags | `js/stock.js?v=28` | Browser cache key for one file | Incremented whenever that file changes |
| `CACHE_NAME` in `sw.js` | `aks-finance-v25` | Service-worker cache bucket | Incremented on each deploy that must discard old cached files |

To release a change: edit the file, bump its `?v=`, bump `CACHE_NAME`, and bump
`APP_VERSION` if the user-visible behaviour changed. The version dialog reads the
`?v=` values straight from the DOM, so it always reports what the device really
loaded - if the header says v1.4.0 but the dialog lists an old `stock.js`, that
device is still on a cached copy and needs a full close and reopen.

## Activation check (Stock tab)

A brand activates a phone the first time its IMEI is used, so a unit that is
still marked **Available** but already activated is almost certainly an
unrecorded sale. Every Available unit has four buttons in its action column:

- **Copy IMEI_1** — puts that row's `IMEI_1` on the clipboard.
- **Copy brand URL** — puts that brand's activation page on the clipboard.
- **Add date** (shown as **Edit date** once a date exists) — asks for the
  activation date and writes it to the Stock sheet's **Activation date** column
  (the old `Settled` column, column R).
- **Sell** — records the sale (see the Stock actions above).

The app deliberately never opens a browser. On Android an installed app cannot
open a real Chrome tab, and every hand-off variant tried (plain link,
`intent://`, `android-app://`) ended up as a browser view covering the app. Copy
and paste has no such problem.

Keep the brand's activation page open in the other half of the split screen.
Then, per unit: tap **Copy IMEI_1**, paste it into the page, solve the captcha,
read the activation date the page reports, and tap **Add date**. **Copy brand
URL** is only needed when the page is not already open in that browser.

Any Available row whose **Activation date** is filled is tinted **amber**, so a
unit that is activated but still not marked sold is impossible to miss.

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

Matching is case- and spacing-insensitive, and a short alias such as `mi` only
matches the whole brand name, so it cannot swallow a brand like `Micromax`. For
a brand that is not listed, **Copy IMEI_1** still works and **Copy brand URL**
warns that no page is saved yet; add another entry to the list when you have the
URL.

Saving the date needs the `markStockActivation` action in Apps Script. After
this change, paste the latest `google-apps-script-separate-sheets.js` into Apps
Script and deploy a **new version of the existing deployment** — editing that
deployment instead of creating one keeps the `/exec` URL in `js/state.js`
unchanged. Until that is done, **Add date** reports
`Unknown action: markStockActivation`.

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
| All-loans overview / EMI history | `js/emi.js`           |
| Add / edit users              | Google Sheets → **Users** tab (see above) |
| Stock tab / stock actions     | `js/stock.js`          |
| Activation page URLs per brand | `js/stock.js`         |
| Apps Script backend           | `google-apps-script-separate-sheets.js` |
| Data model / shared helpers   | `js/state.js`          |
| Page HTML structure           | `index.html`           |

## Google Sheets backend — setup

The app talks to one Apps Script Web App. Its `/exec` URL is the `SHEETS_URL`
constant in `js/state.js`, and the spreadsheet it reads is set by
`SPREADSHEET_ID` at the top of `google-apps-script-separate-sheets.js`.

1. Create a Google Spreadsheet.
2. Go to Extensions → Apps Script → paste
   `google-apps-script-separate-sheets.js`.
3. Set `SPREADSHEET_ID` to that spreadsheet's ID.
4. Deploy as Web App (Execute as: Me, Access: Anyone).
5. Paste the Web App URL into `SHEETS_URL` in `js/state.js`.
6. When the script changes, edit the **existing** deployment and deploy a new
   version, so the `/exec` URL and every installed device keep working.

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
