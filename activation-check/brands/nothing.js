// ── Nothing ──────────────────────────────────────────────────────────────────
// The page at /pages/imei does not submit a normal form. Its JS asks the
// reCAPTCHA widget for a token, then POSTs:
//
//   POST https://ntdock.fastgrowth.app/api/service-portal/searchImeiCodeInfo?imeiCode=<IMEI>
//   {"g-recaptcha-response": "<token>"}
//
// The response carries data.activedate (null when the unit was never activated).
// We drive the same widget and the same endpoint from inside the loaded page, so
// the token is created in a real browser session and the page never has to
// navigate to /pages/imei-result for every unit.
//
// The widget is an INVISIBLE reCAPTCHA. Google shows a challenge the first time
// and often stays quiet for later programmatic execute() calls, which is why a
// batch used to solve the first IMEI and time out on the rest. Each token is
// therefore requested from a real click on the page's own IMEI field: the click
// gives Chromium a user gesture without adding any overlay that could cover the
// challenge. The page title carries the N/M warning. The widget resets itself
// after every token, so one solve per IMEI is inherent to this portal.

const config = require('../config');

const PAGE_URL = 'https://in.nothing.tech/pages/imei';
const API_URL = 'https://ntdock.fastgrowth.app/api/service-portal/searchImeiCodeInfo';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymd(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

// activedate has arrived as a millisecond timestamp, a second timestamp and an
// ISO string depending on the portal build. Accept all three.
function parseActivationDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' || /^\d+$/.test(String(raw).trim())) {
    const n = Number(raw);
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const text = String(raw).trim();
  // The portal is India-facing. If it returns a written date, read the first
  // two numbers as DD/MM unless one of them is plainly a month (> 12).
  const m = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let a = parseInt(m[1], 10);
    let b = parseInt(m[2], 10);
    let day, month;
    if (a > 12 && b <= 12) { day = a; month = b; }
    else if (b > 12 && a <= 12) { month = a; day = b; }
    else { day = a; month = b; }
    let year = parseInt(m[3], 10);
    if (year < 100) year += year < 50 ? 2000 : 1900;
    const d = new Date(year, month - 1, day);
    if (!isNaN(d.getTime())) return d;
  }
  const d = new Date(text);
  return isNaN(d.getTime()) ? null : d;
}

async function ensurePage(page) {
  if (!/in\.nothing\.tech\/pages\/imei/.test(page.url())) {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await page.waitForSelector('input[name="unique_no"]', { timeout: 30000 });
  // The custom element defines execute() immediately, but the widget cannot
  // render until Google's api.js has loaded. Waiting for render() avoids the
  // first "grecaptcha.render is not a function" miss on a cold profile.
  await page.waitForFunction(() => {
    const el = document.querySelector('google-recaptcha');
    return !!el && typeof el.execute === 'function'
      && !!window.grecaptcha && typeof window.grecaptcha.render === 'function';
  }, null, { timeout: 60000 });
}

// Request the token from a real click on the existing IMEI field. The click is
// a genuine user gesture (which is what makes Google show a challenge for every
// IMEI), but it adds no overlay to the page, so nothing can cover the captcha.
// The page title carries the warning instead.
async function armCaptcha(page, imei, position, total) {
  await page.evaluate(({ imei, position, total }) => {
    window.__aksTitleBeforeCaptcha = document.title;
    document.title = '⚠ Solve the captcha ' + position + '/' + total + ' — ' + imei;

    const state = window.__aksCaptcha = { token: null, error: null, started: false };
    const input = document.querySelector('input[name="unique_no"]');
    if (!input) {
      state.error = 'The IMEI field is not ready on the Nothing page.';
      return;
    }

    const onClick = () => {
      if (state.started) return;
      state.started = true;

      const el = document.querySelector('google-recaptcha');
      if (!el || typeof el.execute !== 'function') {
        state.error = 'The reCAPTCHA widget is not ready on the Nothing page.';
        return;
      }
      const done = (value) => {
        if (state.token || state.error) return;
        if (value) state.token = value;
        else state.error = 'reCAPTCHA returned an empty token.';
      };
      const failed = (message) => {
        if (!state.token && !state.error) state.error = message;
      };
      try {
        // Signature: execute(success, closeCallback, expiredCallback, errorCallback)
        el.execute(
          done,
          () => failed('The captcha window was closed before it was solved.'),
          () => failed('The captcha expired before it was solved.'),
          () => failed('reCAPTCHA reported an error.')
        );
      } catch (err) {
        failed(err && err.message ? err.message : String(err));
      }
    };

    window.__aksCaptchaClick = onClick;
    input.addEventListener('click', onClick);

    // The invisible widget anchors its challenge to the widget, so make sure
    // that area is in view before the challenge opens.
    const widget = document.querySelector('google-recaptcha');
    if (widget && widget.scrollIntoView) {
      widget.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, { imei: imei, position: position || 1, total: total || 1 });
}

async function disarmCaptcha(page) {
  try {
    await page.evaluate(() => {
      const input = document.querySelector('input[name="unique_no"]');
      if (input && window.__aksCaptchaClick) {
        input.removeEventListener('click', window.__aksCaptchaClick);
      }
      delete window.__aksCaptchaClick;
      if (window.__aksTitleBeforeCaptcha) {
        document.title = window.__aksTitleBeforeCaptcha;
        delete window.__aksTitleBeforeCaptcha;
      }
      window.__aksCaptcha = null;
    });
  } catch (e) {
    // The page may already be gone; nothing to clean up.
  }
}

async function getCaptchaToken(page, imei, position, total, log, setPhase) {
  const label = position && total ? ' (' + position + '/' + total + ')' : '';
  log('Captcha required' + label + '. Solve it in the Chromium window.');
  setPhase('waiting_for_captcha',
    'Captcha ' + position + ' of ' + total + ' — solve it for ' + imei + ' in the Chromium window.');

  await armCaptcha(page, imei, position, total);
  await page.bringToFront();

  try {
    // A trusted click on the IMEI field turns the invisible widget's execute()
    // into a user gesture, which is what makes Google show a challenge.
    await page.click('input[name="unique_no"]', { timeout: 15000 });
  } catch (err) {
    log('Could not click the IMEI field; solve the challenge if it is visible.', 'warn');
  }
  await page.bringToFront();

  try {
    const handle = await page.waitForFunction(() => {
      const state = window.__aksCaptcha;
      if (!state) return null;
      if (state.token) return { token: state.token };
      if (state.error) return { error: state.error };
      return null;
    }, null, { timeout: config.captchaTimeoutMs, polling: 500 });

    const outcome = await handle.jsonValue();
    if (outcome && outcome.token) return outcome.token;
    throw new Error((outcome && outcome.error) || 'The captcha was not solved in time.');
  } catch (err) {
    const text = err && err.message ? err.message : String(err);
    if (/timeout/i.test(text)) throw new Error('The captcha was not solved in time.');
    throw new Error(text);
  } finally {
    await disarmCaptcha(page);
  }
}

async function resetWidget(page) {
  try {
    await page.evaluate(() => {
      const el = document.querySelector('google-recaptcha');
      if (el && typeof el.reset === 'function') el.reset();
    });
  } catch (e) {
    // A reset failure is harmless; the next page load rebuilds the widget.
  }
}

// After a missed captcha the widget can be left mid-challenge. A reload gives
// the next IMEI a clean widget instead of inheriting the stale one.
async function reloadPage(page) {
  try {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('input[name="unique_no"]', { timeout: 15000 });
  } catch (e) {
    // ensurePage() retries with a longer timeout at the start of the next unit.
  }
}

async function submitImei(page, imei, token) {
  return await page.evaluate(async (args) => {
    const res = await fetch(args.api + '?imeiCode=' + encodeURIComponent(args.imei), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'g-recaptcha-response': args.token }),
    });
    let text = '';
    try { text = await res.text(); } catch (e) {}
    return { http: res.status, text: text };
  }, { api: API_URL, imei: imei, token: token });
}

async function run({ page, item, log, setPhase, position, total }) {
  await ensurePage(page);
  await page.bringToFront();

  const imei = String(item.imei1 || item.imei || '').trim();
  if (!imei) return { status: 'ERROR', error: 'Row has no IMEI.' };

  let lastError = null;
  const attempts = Math.max(1, config.maxAttempts || 1);

  // One attempt by default: a missed or wrong captcha should fail this row
  // immediately, not hold the whole batch for another timeout.
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (page.isClosed()) throw new Error('The Chromium window was closed.');
    setPhase('checking', attempt === 1
      ? 'Requesting activation status for ' + imei + '…'
      : 'Retrying ' + imei + ' (attempt ' + attempt + '/' + attempts + ')…');

    let token;
    try {
      token = await getCaptchaToken(page, imei, position || 1, total || 1, log, setPhase);
    } catch (err) {
      lastError = err;
      await resetWidget(page);
      setPhase('checking',
        'Captcha not completed for ' + imei + '. Moving to the next unit.');
      await sleep(600);
      await reloadPage(page);
      continue;
    }

    setPhase('checking', 'Submitting ' + imei + '…');
    let response;
    try {
      response = await submitImei(page, imei, token);
    } catch (err) {
      await resetWidget(page);
      lastError = err;
      // A dead page usually means the user closed the browser window.
      if (page.isClosed()) throw new Error('The Chromium window was closed.');
      await reloadPage(page);
      continue;
    }

    let body = null;
    try { body = JSON.parse(response.text); } catch (e) {}

    if (body && body.data
      && (String(body.code) === '200' || String(body.status || '').toLowerCase() === 'success')) {
      const active = parseActivationDate(body.data.activedate);
      const result = {
        status: active ? 'ACTIVATED' : 'NOT ACTIVATED',
        activationDate: active ? ymd(active) : '',
        activationRaw: body.data.activedate === null || body.data.activedate === undefined
          ? '' : String(body.data.activedate),
        productModel: body.data.productmodel || '',
        productStatus: body.data.productstatus || '',
        productConfiguration: body.data.productconfiguration || '',
        imei1: body.data.imei1 || '',
        imei2: body.data.imei2 || '',
        source: PAGE_URL,
      };
      // Reusing the same widget straight after a token made every other IMEI
      // miss its challenge. A fresh page gives the next unit a clean widget.
      await reloadPage(page);
      return result;
    }

    const message = String((body && (body.message || body.error)) || response.text || ('HTTP ' + response.http));
    if (/robot|captcha/i.test(message)) {
      lastError = new Error('The captcha was not accepted. Run the check again and solve it when the challenge appears.');
      await resetWidget(page);
      setPhase('checking', 'Captcha rejected for ' + imei + '. Moving to the next unit.');
      await sleep(600);
      await reloadPage(page);
      continue;
    }
    if (/not detected|invalid|not found|no record/i.test(message)) {
      await reloadPage(page);
      return { status: 'NOT FOUND', error: message, source: PAGE_URL };
    }

    lastError = new Error(message);
    break;
  }

  await reloadPage(page);
  return {
    status: 'ERROR',
    error: lastError ? lastError.message : 'Unknown error from the Nothing portal.',
    source: PAGE_URL,
  };
}

module.exports = {
  id: 'nothing',
  label: 'Nothing',
  matches(item) {
    return /nothing/i.test(String(item.brand || '')) || /nothing/i.test(String(item.model || ''));
  },
  run,
  // Used by the local smoke test; the server only calls run().
  __test: { ensurePage, armCaptcha, disarmCaptcha, getCaptchaToken },
};
