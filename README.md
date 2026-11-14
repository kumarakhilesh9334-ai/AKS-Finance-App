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
├── Serve App on LAN.bat        ← Serve a no-cache copy to the tablet over Wi-Fi
├── Start Activation Checker.bat
├── .gitattributes              ← Keeps repo files LF, batch files CRLF
└── google-apps-script-separate-sheets.js  ← Paste into Apps Script (see below)
```

## How to run

Just open `index.html` in a browser — no build step, no server needed.

Demo credentials:
- **Admin:** AKS / 0000
- **Agent:** agent1 / 1111

## Testing on the tablet without deploying

The tablet only sees whatever is at the URL it was installed from, so a change
has to be served from *some* address it can reach. Git is just one way to get
files onto an address; none of the options below touch the repo.

### 1. LAN copy from this PC — fastest, no internet needed

Double-click **`Serve App on LAN.bat`**. It picks a free port (8080 is often
taken), copies the app files to a temp folder (not the whole project —
`activation-check/reports` and `activation-check/.profile` stay private), and
prints the exact URL, e.g. `http://192.168.1.6:8081/`. Open that on the tablet,
same Wi-Fi.

What this does and does not test:

- Good for: layout, the version pill, the version dialog, **Loaded files**, and
  whether the `?v=` bumps actually landed.
- Not representative of the installed app: a plain `http://` address is not a
  secure context, so **no service worker** registers and the tablet will not
  offer to install it. The version dialog reports the service worker as
  *unavailable (http, not a secure context)* — that is expected here.
- Tapping **Check** in this mode opens an ordinary Chrome tab (the plain link
  path), so it does *not* prove that the installed app will hand off to Chrome.

Re-run the script after editing files; it re-copies every time. Close the
window to stop sharing. If Windows asks about the firewall, allow **Private
networks** only.

### 2. HTTPS tunnel — tests the real installed-app behaviour

An installed PWA needs `https://` (or `localhost`). A temporary tunnel gives you
that without any hosting account:

```
python -m http.server 8080 --bind 127.0.0.1 --directory "%TEMP%\aks-lan"
cloudflared tunnel --url http://localhost:8080
```

(Download the standalone `cloudflared-windows-amd64.exe` from the Cloudflare
GitHub releases page — a single file, no installer. `Serve App on LAN.bat` is
the quick way to produce the `aks-lan` folder.)

Open the printed `https://….trycloudflare.com` URL on the tablet and use
**Install app** / *Add to Home screen*. That is a genuine WebAPK, so the Check
button exercises the real `intent://` path. Two caveats: the URL changes every
time cloudflared restarts, and the install is a separate origin from the
deployed app (new icon, fresh `localStorage`, so you have to log in again).

### 3. `adb reverse` over USB — HTTPS-free secure context

With Android platform-tools installed (a zip, no admin rights needed) and USB
debugging on:

```
adb reverse tcp:8080 tcp:8080
```

Then open `http://localhost:8080/` on the tablet. `localhost` counts as a secure
context, so the service worker registers and Chrome will install it — the
installed-app Check behaviour can be tested with no hosting at all.

### 4. Direct upload, if a real deploy is acceptable

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

The header shows a small pill such as **v1.2.3** next to **Sign out**. Tap it for
*Version info*: app version, release date, the files this device actually loaded,
service-worker state, and the exact link mode used by the Stock **Check** button.
**Copy details** puts that block on the clipboard for support.

There are three separate numbers, and only the first one is the app version:

| Where | Example | Meaning | How it changes |
|---|---|---|---|
| `APP_VERSION` in `js/version.js` | `1.2.3` | The version the header shows | Bumped by hand for a release |
| `?v=N` on `<script>` / `<link>` tags | `js/stock.js?v=27` | Browser cache key for one file | Incremented whenever that file changes |
| `CACHE_NAME` in `sw.js` | `aks-finance-v22` | Service-worker cache bucket | Incremented on each deploy that must discard old cached files |

To release a change: edit the file, bump its `?v=`, bump `CACHE_NAME`, and bump
`APP_VERSION` if the user-visible behaviour changed. The version dialog reads the
`?v=` values straight from the DOM, so it always reports what the device really
loaded - if the header says v1.2.3 but the dialog lists an old `stock.js`, that
device is still on a cached copy and needs a full close and reopen.

## Activation checker (Stock tab)

The Stock tab offers two admin-only ways to check whether a unit that is still
marked **Available** has been activated in the brand's system. Both are for
spotting a recent unrecorded sale.

### Manual, row by row

Every Available unit now has three buttons:

- **Check** copies that row's `IMEI_1` and opens the brand's own activation page.
  Paste the IMEI there, solve the captcha, and read the activation date the page
  shows. See *Opening the page from an installed PWA* below for what "opens"
  means on Android.
- **Add date** (shown as **Edit date** once a date exists) asks for that date
  and writes it to the Stock sheet's **Activation date** column — the old
  `Settled` column, column R.
- **Sell** records the sale (see the Stock actions above).

Any Available row whose **Activation date** is filled is tinted **amber** in the
Stock tab, so a unit that is activated but still not marked sold is impossible
to miss.

#### Opening the page from an installed PWA (Android)

Tested on the Android tablet: **an installed PWA cannot open a real Chrome tab.**
Chrome hosts the installed app itself, and it will not start a second Chrome task
for a link that came from inside itself. A plain link, an `intent://` naming
`com.android.chrome`, an intent pinned to Chrome's main activity, and an
`android-app://` hand-off all produce the same thing: a Custom Tab — the browser
view with a close X and no tab strip that covers the whole app. That is Chrome
behaving as designed, not a bug in this app, so no link variant can fix it.

What does work, in order of convenience:

1. **Different browser app** — `intent://…;package=<other browser>`. Chrome is
   willing to launch a *different* browser, and that browser keeps its own
   window in the other half of the split screen. Open the brand page once in
   that browser, leave it there, and Check will re-open it per row. **This is
   the option that works on the tablet**, and its two requirements are easy to
   get wrong, so both are documented below.
2. **Copy IMEI only** — do not navigate at all. The app stays exactly where it
   is, so the brand page can stay pinned beside it permanently. Paste, solve the
   captcha, tap the next row.
3. **Normal link** — a plain `target="_blank"`. Correct on desktop, on iOS and in
   an ordinary browser tab; inside the installed app it is what produces the
   Custom Tab.

From v1.2.0 **Auto** means option 2 inside the installed app, and a plain link
everywhere else, because that is the only behaviour that always leaves the app
usable. The three Chrome-specific modes remain selectable for testing, but they
are known not to escape the app.

##### Why the hand-off sometimes shows an "open with" chooser

Because **no default browser is set on the tablet**. Chrome hands the `intent://`
to Android, and an `https` hand-off with no `component=` is resolved by the
system: with no default browser, every browser on the device is a candidate, so
Android asks. The dialog lists Chrome and Samsung Internet side by side, which
is only possible when nothing is configured as *the* browser.

Neither the `BROWSABLE` category nor the `package=` value prevents this. Both
were tried, and v1.2.2 with the category added changed nothing on the device.
Chrome discards the package constraint when it hands a plain `https` URL back to
the system, so the constraint has to be spelled out as a component instead.

There are two independent fixes, and either one is enough:

1. **Set a default browser** — Settings → Apps → Choose default apps → Browser
   app → **Samsung Internet**. Android then has an answer without asking, and the
   chooser stops appearing for every app, not just this one. This needs no code
   change and no deploy. Tapping **Always** once in the chooser has the same
   effect.
2. **Pin the activity** — from v1.2.3 the Check link is pinned automatically. The
   **Activity** field under *Browser app to open* is prefilled with the known
   activity for the selected package:

   | Browser | Activity |
   |---|---|
   | Samsung Internet | `com.sec.android.app.sbrowser.BrowserActivity` |
   | Chrome | `com.google.android.apps.chrome.Main` |
   | Firefox | `org.mozilla.firefox.App` |
   | Microsoft Edge | `com.microsoft.ruby.Main` |

   A pinned activity becomes `component=<package>/<activity>`, which resolves to
   exactly one activity, so a chooser is impossible. Use **Test link** to apply a
   change immediately — no Stock row and no redeploy needed.

Clearing the Activity field is an explicit *unpin*: the link goes back to
`package=` only, and the chooser can return. An empty field is stored as an empty
value, so it is not confused with "never touched" (which means "use the pin").

##### "code: 401, message: unauthorized" after the hand-off

That is the brand's own server rejecting the request, not something the app
sends. Two things are worth ruling out before changing anything:

1. **First launch in a fresh browser.** A browser that has never visited the
   brand's site has no session cookie or consent state, and some activation
   pages refuse a deep link without one. Open the brand's page once in that
   browser normally (address bar, not from the app), solve any captcha or
   cookie prompt, then tap **Check** again. If it now works, the hand-off is
   fine and only the first visit needed a session. This is the most likely
   cause when Samsung Internet was reached through the chooser, because that
   visit was its first ever to the site.
2. **The browser is blocked by the site.** If the same URL typed directly into
   Samsung Internet also returns 401, the site is rejecting that browser
   (usually its user agent), and no link format can help. Switch the package to
   `org.mozilla.firefox` or `com.microsoft.emmx` (Edge) and press **Test link**,
   then see whether the 401 follows the browser or disappears.

The app sends the brand URL unchanged, with no extra headers, so the only
variables are which browser opens it and what state that browser is in.

The **version dialog** (tap the version pill next to **Sign out**) holds the
selector:

| Mode | Behaviour |
|---|---|
| Auto | copy-only inside the installed app, normal link everywhere else |
| Copy IMEI only | never navigates; just copies the IMEI |
| Different browser app | `intent://` aimed at the package in the field below it, pinned to that browser's known activity |
| Normal link | plain `<a target="_blank">` |
| `intent://` / pinned / `android-app://` | Chrome hand-off attempts; all produce a Custom Tab on the tested tablet |

Both choices are saved per device in `localStorage` (`aks_check_mode` and
`aks_check_pkg`) and take effect on the next Stock render. The activity pin is
stored too (`aks_check_activity`) once it has been edited. The browser field
accepts any package name; the suggestions are Samsung Internet
(`com.sec.android.app.sbrowser`, the default), Firefox (`org.mozilla.firefox`),
Edge (`com.microsoft.emmx`), Opera, Brave and DuckDuckGo.

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
