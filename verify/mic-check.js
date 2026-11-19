// Checks the app page's microphone gate in Chromium with a fake mic: Start stays disabled until the mic is tested and
// heard, a blocked mic shows a clear message, and a full session still produces captions.
// Usage: node mic-check.js <speech.wav> [http://127.0.0.1:3000/]
const { chromium } = require('playwright');
const assert = require('assert');
const path = require('path');
const [wav, url = 'http://127.0.0.1:3000/'] = process.argv.slice(2);

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.resolve(wav)}`] });
  const shots = path.join(__dirname, 'video');

  // 1) mic allowed
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await p.goto(url); await p.waitForSelector('.chip');
  assert(await p.isDisabled('#go'), 'Start must be disabled before the mic test');
  console.log('before test:', await p.textContent('#michint'));
  await p.screenshot({ path: path.join(shots, 'mic-before.png') });
  await p.click('#mictest');
  await p.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 15000 });
  console.log('after test :', await p.textContent('#michint'), '| devices:', await p.$$eval('#mic option', (o) => o.map((x) => x.textContent).join(', ')));
  await p.screenshot({ path: path.join(shots, 'mic-ok.png') });
  await p.click('#go');
  await p.waitForFunction(() => document.querySelector('.now')?.textContent, null, { timeout: 30000 });
  await p.waitForTimeout(8000);
  const caption = await p.textContent('.lane');
  console.log('caption    :', caption.replace(/\s+/g, ' ').slice(0, 120));
  await p.click('#go'); // stop
  await p.waitForTimeout(500);
  assert.strictEqual(await p.textContent('#go'), 'Start');
  assert(!(await p.isDisabled('#go')), 'Start must stay enabled after a working session');
  console.log('after stop :', await p.textContent('#michint'));

  // 2) mic blocked
  const ctx2 = await browser.newContext({ permissions: [] });
  const p2 = await ctx2.newPage();
  await p2.goto(url); await p2.waitForSelector('.chip');
  await p2.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); });
  await p2.click('#mictest');
  await p2.waitForFunction(() => document.getElementById('michint').classList.contains('bad'));
  console.log('blocked    :', await p2.textContent('#michint'));
  assert(await p2.isDisabled('#go'), 'Start must stay disabled when the mic is blocked');
  await p2.screenshot({ path: path.join(shots, 'mic-blocked.png') });

  await browser.close();
  console.log('OK');
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
