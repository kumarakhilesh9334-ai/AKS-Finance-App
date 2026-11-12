// Copy this file to <brand>.js, fill it in, and add it to brands/index.js.
//
// The runner opens ONE Chromium window and keeps one page alive for the whole
// batch. Your run() must therefore leave the page in a state the next call can
// use (or navigate back itself).
//
// Return shape:
//   {
//     status: 'ACTIVATED' | 'NOT ACTIVATED' | 'NOT FOUND' | 'ERROR',
//     activationDate: 'YYYY-MM-DD' or '',
//     productModel: '...',
//     productStatus: '...',
//     error: '...',          // only when status is NOT FOUND or ERROR
//     source: 'https://...'
//   }

module.exports = {
  id: 'example',
  label: 'Example brand',
  matches(item) {
    return /example/i.test(String(item.brand || ''));
  },
  async run({ page, item, log, setPhase }) {
    setPhase('checking', 'Opening the brand page…');
    await page.goto('https://example.com/imei-check', { waitUntil: 'domcontentloaded' });

    setPhase('checking', 'Submitting IMEI ' + item.imei1 + '…');
    await page.fill('input[name="imei"]', item.imei1);
    await page.click('button[type="submit"]');

    // If this brand shows a captcha, wait for the result instead of timing out.
    // The user solves it in the visible browser window.
    const text = await page.locator('body').innerText({ timeout: 300000 });

    const match = text.match(/Activation date:\s*([0-9]{1,2}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4})/i);
    if (!match) {
      return { status: 'NOT FOUND', error: 'Activation date not present in the page.', source: page.url() };
    }
    return {
      status: 'ACTIVATED',
      activationDate: match[1],
      productModel: '',
      productStatus: '',
      source: page.url(),
    };
  },
};
