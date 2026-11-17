// Records /live.html (two-stage EN->ZH) with a synthetic mic fed from a WAV; writes video/live-timing.json for muxing.
// Usage: node record-live.js <speech.wav> <http://127.0.0.1:3000/live.html?token=...>
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const [wavPath, url] = process.argv.slice(2);
const outDir = path.join(__dirname, 'video');
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const b64 = fs.readFileSync(wavPath).toString('base64');
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: outDir, size: { width: 1280, height: 720 } },
    permissions: ['microphone'],
  });
  await ctx.addInitScript((payload) => {
    window.__ev = []; window.__audioStartPerf = null; window.__audioDur = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      const ac = new AudioContext();
      const buf = await ac.decodeAudioData(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)).buffer);
      const dest = ac.createMediaStreamDestination();
      const src = ac.createBufferSource(); src.buffer = buf; src.connect(dest); src.start();
      window.__audioStartPerf = performance.now(); window.__audioDur = buf.duration;
      return dest.stream;
    };
    // log every Chinese text change, and whether it was a partial or the final
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => {
        document.querySelectorAll('.cap').forEach((c, i) => {
          const zh = c.querySelector('.zh').textContent, kind = c.classList.contains('partial') ? 'partial' : 'final';
          if (c.__last !== kind + zh) { c.__last = kind + zh; window.__ev.push({ t: performance.now(), kind, zh, lat: c.querySelector('.lat').textContent }); }
        });
      }).observe(document.getElementById('caps'), { childList: true, subtree: true, characterData: true, attributes: true });
    });
  }, b64);

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.click('#btn');
  await page.waitForFunction(() => window.__audioStartPerf, null, { timeout: 15000 });
  const dur = await page.evaluate(() => window.__audioDur);
  await page.waitForTimeout(dur * 1000 + 3000); // audio + time for the last final

  const timing = await page.evaluate(() => ({ audioStartPerf: window.__audioStartPerf, audioDur: window.__audioDur, events: window.__ev }));
  fs.writeFileSync(path.join(outDir, 'live-timing.json'), JSON.stringify(timing, null, 1));
  await page.screenshot({ path: path.join(outDir, 'live-final.png') });
  const v = page.video(); await ctx.close(); await browser.close();
  fs.renameSync(await v.path(), path.join(outDir, 'live-silent.webm'));
  const fin = timing.events.filter((e) => e.kind === 'final');
  console.log(`audio start ${Math.round(timing.audioStartPerf)} ms; ${timing.events.length - fin.length} partial updates, ${fin.length} finals`);
  fin.forEach((e) => console.log(`  +${((e.t - timing.audioStartPerf) / 1000).toFixed(2)}s ${e.zh}  [${e.lat}]`));
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
