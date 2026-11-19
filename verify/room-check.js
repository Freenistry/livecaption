// Checks rooms end to end in Chromium: a speaker tab (app.html?room=x, fake mic playing a WAV) and a listener tab
// (/r/x, no mic). The listener must see the speaker's languages, pick one, and get its captions.
// Usage: node room-check.js <speech.wav> [http://127.0.0.1:3001]
const { chromium } = require('playwright');
const assert = require('assert');
const path = require('path');
const [wav, base = 'http://127.0.0.1:3001'] = process.argv.slice(2);
const room = `check-${process.pid}`;

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.resolve(wav)}`] });
  const shots = path.join(__dirname, 'video');

  // listener first: it must wait for the speaker
  const lc = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const l = await lc.newPage(); l.on('pageerror', (e) => console.log('  [listener pageerror]', e.message));
  await l.goto(`${base}/r/${room}`);
  await l.waitForFunction(() => /waiting/.test(document.getElementById('status').textContent));
  console.log('listener before speaker:', await l.textContent('#status'));

  // speaker: pick es + de, test the mic, start
  const sc = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 900 } });
  const s = await sc.newPage(); s.on('pageerror', (e) => console.log('  [speaker pageerror]', e.message));
  await s.goto(`${base}/?room=${room}`); await s.waitForSelector('.chip');
  assert((await s.textContent('#sharelink')).endsWith(`/r/${room}`), 'speaker page shows the listener link');
  for (const b of await s.$$('#to .chip[aria-pressed="true"]')) await b.click(); // clear saved picks
  await s.click('#to .chip:text-is("Spanish")'); await s.click('#to .chip:text-is("German")');
  await s.click('#mictest'); await s.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 15000 });
  await s.click('#go');

  // listener: within the 5 s poll it sees the room's languages, then picks German
  await l.waitForSelector('#to .chip:text-is("German")', { timeout: 15000 });
  const langs = await l.$$eval('#to .chip', (bs) => bs.map((b) => b.textContent));
  console.log('listener languages:', langs.join(', '));
  assert.deepStrictEqual(langs.sort(), ['German', 'Spanish']);
  await l.click('#to .chip:text-is("German")');
  await l.waitForFunction(() => document.getElementById('now').textContent.length > 10 || document.getElementById('past').textContent.length > 10, null, { timeout: 60000 });
  await l.waitForTimeout(8000);
  const text = (await l.textContent('#past')) + ' | ' + (await l.textContent('#now'));
  console.log('listener (de):', text.slice(0, 200));
  await l.screenshot({ path: path.join(shots, 'room-listener.png') });
  await s.screenshot({ path: path.join(shots, 'room-speaker.png') });

  await s.click('#go'); // stop: listener is told
  await l.waitForFunction(() => /stopped/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  console.log('listener after stop:', await l.textContent('#status'));
  await browser.close();
  console.log('room check passed');
})().catch((e) => { console.error(e); process.exit(1); });
