// Every knob is an environment variable so the .bat launcher can stay dumb.
const path = require('path');

const num = (name, fallback) => {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) ? n : fallback;
};

module.exports = {
  host: process.env.AKS_ACTIVATION_HOST || '127.0.0.1',
  port: num('AKS_ACTIVATION_PORT', 8787),
  rootDir: path.resolve(__dirname, '..'),
  profileDir: path.resolve(__dirname, '.profile'),
  reportsDir: path.resolve(__dirname, 'reports'),
  // Headed by default: the captcha has to be solvable by a human.
  headless: process.env.AKS_ACTIVATION_HEADLESS === '1',
  // How long to wait for the user to finish a captcha before failing that row.
  // 3 minutes is deliberate: real solves have taken ~90 seconds, and cutting
  // them off at 90s caused avoidable ERROR rows. The user can still stop the
  // batch at any time from the app.
  captchaTimeoutMs: num('AKS_CAPTCHA_TIMEOUT_MS', 180 * 1000),
  // Attempts per IMEI. One is deliberate: retrying the same row mostly means
  // the user did not see the challenge in time, and every retry costs another
  // captcha wait. Raise AKS_MAX_ATTEMPTS if a flaky brand needs more.
  maxAttempts: num('AKS_MAX_ATTEMPTS', 1),
  // Work through the sheet from the bottom up. The first row of a batch is the
  // one most likely to get a captcha solve, so this checks the newest stock
  // first. Set AKS_REVERSE_ORDER=0 to keep sheet order.
  reverseOrder: process.env.AKS_REVERSE_ORDER !== '0',
  // 1.4 s between IMEIs keeps us under the 60 requests/minute limit.
  requestDelayMs: num('AKS_REQUEST_DELAY_MS', 1400),
  maxItems: num('AKS_MAX_ITEMS', 500),
  // Set AKS_NO_OPEN=1 to stop the server from opening the browser on start.
  noOpen: process.env.AKS_NO_OPEN === '1',
};
