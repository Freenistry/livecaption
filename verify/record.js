// Records the live-caption page end to end with a synthetic microphone,
// and writes timing.json so the speech WAV can be muxed in sync afterwards.
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
    window.__events = [];
    window.__audioStartPerf = null;
    window.__navPerf = performance.now();

    navigator.mediaDevices.getUserMedia = async () => {
      const ac = new AudioContext();
      const bin = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      const buf = await ac.decodeAudioData(bin.buffer);
      const dest = ac.createMediaStreamDestination();
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      src.start();
      window.__audioStartPerf = performance.now();
      return dest.stream;
    };

    document.addEventListener('DOMContentLoaded', () => {
      const caps = document.getElementById('caps');
      new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && n.classList && n.classList.contains('cap')) {
              window.__events.push({
                t: performance.now(),
                dst: n.querySelector('.dst')?.textContent || '',
              });
            }
          }
        }
      }).observe(caps, { childList: true });
    });
  }, b64);

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.click('#btn');
  const started = Date.now();

  let count = 0;
  while (Date.now() - started < 60000) {
    count = await page.locator('.cap').count();
    if (count >= 3) break;
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(1500);

  const timing = await page.evaluate(() => ({
    navPerf: window.__navPerf,
    audioStartPerf: window.__audioStartPerf,
    events: window.__events,
  }));
  fs.writeFileSync(path.join(outDir, 'timing.json'), JSON.stringify(timing, null, 2));
  console.log('nav at', Math.round(timing.navPerf), 'ms; audio started at', Math.round(timing.audioStartPerf), 'ms');
  timing.events.forEach((e, i) =>
    console.log(`  caption ${i + 1} displayed at audio +${Math.round(e.t - timing.audioStartPerf)} ms :: ${e.dst}`)
  );

  await page.screenshot({ path: path.join(outDir, 'final.png') });
  await ctx.close();
  await browser.close();

  const vids = fs.readdirSync(outDir).filter((f) => f.endsWith('.webm') && f !== 'silent.webm');
  for (const v of vids) {
    const from = path.join(outDir, v);
    const to = path.join(outDir, 'silent.webm');
    if (from !== to) fs.renameSync(from, to);
  }
  console.log('silent video:', path.join(outDir, 'silent.webm'));
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
