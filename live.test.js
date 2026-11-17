// End-to-end check of /live: streams a 16 kHz mono PCM16 WAV at real time in 80 ms frames, prints captions and latency.
// Usage: node live.test.js <file.wav> [ws://127.0.0.1:3000/live?token=...]
const fs = require('fs');
const assert = require('assert');
const WebSocket = require('ws');

const [file, url = 'ws://127.0.0.1:3000/live'] = process.argv.slice(2);
const b = fs.readFileSync(file);
const at = b.indexOf('data') + 8;
assert(at > 8 && b.readUInt32LE(24) === 16000 && b.readUInt16LE(22) === 1, 'need 16 kHz mono PCM16 WAV');
const pcm = Buffer.concat([b.subarray(at), Buffer.alloc(32000)]); // + 1 s silence so the last endpoint fires
const FRAME = 2560; // 80 ms

const ws = new WebSocket(url);
const ev = [], t0 = Date.now();
ws.on('message', (d) => { const m = JSON.parse(d); m.t = Date.now() - t0; ev.push(m); if (m.type === 'final') console.log(`[${(m.t / 1000).toFixed(1)}s +${m.sinceEndpointMs}ms] ${m.en}\n    ${m.zh}  (${m.mt})`); if (m.type === "status" || m.type === "endpoint") console.log(m.type, m.msg || m.en); });
ws.on('open', () => {
  let i = 0;
  const tick = () => {
    if (i * FRAME >= pcm.length) return finish();
    ws.send(pcm.subarray(i * FRAME, (i + 1) * FRAME)); i++;
    setTimeout(tick, Math.max(0, t0 + i * 80 - Date.now())); // real-time pacing without drift
  };
  tick();
});
ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });

function finish() {
  ws.send('flush');
  setTimeout(() => {
    ws.close();
    const q = (xs, p) => xs.length ? Math.round([...xs].sort((a, c) => a - c)[Math.min(xs.length - 1, Math.floor(xs.length * p))]) : null;
    const zp = ev.filter((e) => e.type === 'zh_partial'), fin = ev.filter((e) => e.type === 'final');
    const r = {
      enPartials: ev.filter((e) => e.type === 'en_partial').length,
      zhPartials: zp.length, zhPartialMtMs: { p50: q(zp.map((e) => e.mtMs), .5), p90: q(zp.map((e) => e.mtMs), .9) },
      zhPartialAskToSendMs: { p50: q(zp.map((e) => e.askToSendMs), .5), p90: q(zp.map((e) => e.askToSendMs), .9) },
      finals: fin.length, finalSinceEndpointMs: { p50: q(fin.map((e) => e.sinceEndpointMs), .5), max: q(fin.map((e) => e.sinceEndpointMs), 1) },
      finalAsrMs: q(fin.map((e) => e.asrMs), .5), finalMtMs: q(fin.map((e) => e.mtMs), .5),
    };
    console.log(JSON.stringify(r));
    assert(zp.length > 0, 'no Chinese partials');
    assert(fin.length > 0 && fin.every((e) => e.zh), 'no Chinese finals');
    process.exit(0);
  }, 4000);
}
