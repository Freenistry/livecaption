// Records the live-caption page end to end with a synthetic microphone.
// The page's getUserMedia is stubbed to play a WAV into the same audio path a real mic would use.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const wavPath = process.argv[2];
const url = process.argv[3];
const outDir = path.join(__dirname, 'video');
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const b64 = fs.readFileSync(wavPath).toString('base64');

  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: outDir, size: { width: 1280, height: 720 } },
    permissions: ['microphone'],
  });

  await ctx.addInitScript((payload) => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ac = new AudioContext();
      const bin = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      const buf = await ac.decodeAudioData(bin.buffer);
      const dest = ac.createMediaStreamDestination();
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      src.start();
      window.__feed = { ac, src, dest };
      return dest.stream;
    };
  }, b64);

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text()); });

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.click('#btn');
  const started = Date.now();

  let count = 0;
  while (Date.now() - started < 60000) {
    count = await page.locator('.cap').count();
    if (count >= 3) break;
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(2500);

  const caps = await page.locator('.cap').allInnerTexts();
  console.log('captions rendered:', count);
  caps.forEach((c, i) => console.log(`  [${i + 1}]`, c.replace(/\n/g, ' | ')));

  await page.screenshot({ path: path.join(outDir, 'final.png') });
  await ctx.close();
  await browser.close();

  const vids = fs.readdirSync(outDir).filter((f) => f.endsWith('.webm'));
  for (const v of vids) {
    const from = path.join(outDir, v);
    const to = path.join(outDir, 'caption-proof.webm');
    if (from !== to) fs.renameSync(from, to);
  }
  console.log('video:', path.join(outDir, 'caption-proof.webm'));
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
