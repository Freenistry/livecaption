// End-to-end eval through a running server: streams FLEURS dev English audio over /live (exactly what the browser does)
// and scores what comes back against the human reference. Works the same on server.js (Node) and server_ex (Elixir).
//   grey  = the last tr_partial shown for each segment (what the viewer saw just before the final)
//   white = the finals
// Usage: node eval-live.js [url=ws://127.0.0.1:3000/live] [n=50] [to=zh-Hans,es,hi,ja] [speed=1] [label=node] [token=]
//   to: 1-4 targets per session; pass to=all to cover the 15 pilot targets in 4 passes. speed>1 sends audio faster than
//   real time (finals stay comparable, grey and latency do not).
// Writes: one row per target to eval-results.jsonl (label "live:<label>"), detail to data/eval-live-<label>.json.
const fs = require('fs'), path = require('path');
const WebSocket = require('ws');
const { ensureData, readWav, chrf, chrfStats, DIR } = require('./eval');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const URL_ = args.url || 'ws://127.0.0.1:3000/live', N = +(args.n || 50), SPEED = +(args.speed || 1), LABEL = args.label || 'node';
const PILOT = ['zh-Hans', 'hi', 'es', 'ar', 'fr', 'bn', 'pt', 'ru', 'id', 'ur', 'de', 'ja', 'mr', 'vi', 'te'];
const FLEURS = { 'zh-Hans': 'cmn_hans_cn', hi: 'hi_in', es: 'es_419', ar: 'ar_eg', fr: 'fr_fr', bn: 'bn_in', pt: 'pt_br', ru: 'ru_ru',
  id: 'id_id', ur: 'ur_pk', de: 'de_de', ja: 'ja_jp', mr: 'mr_in', vi: 'vi_vn', te: 'te_in' }; // dev.tsv fetched by eval-targets.js
const all = (args.to || 'zh-Hans,es,hi,ja') === 'all' ? PILOT : args.to.split(',');
const passes = []; for (let i = 0; i < all.length; i += 4) passes.push(all.slice(i, i + 4));
const FRAME = 1280; // 80 ms
const q = (xs, p) => (xs.length ? Math.round([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]) : null);

function refs(code) {
  const f = path.join(DIR, `${FLEURS[code]}-dev.tsv`);
  if (!fs.existsSync(f)) throw new Error(`missing ${f}: run node eval-targets.js n=1 only=${code} once to fetch it`);
  return new Map(fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => l.split('\t')).map((c) => [c[0], c[2]]));
}

function pcm16(file) { // peak-normalised to -6 dBFS (as eval.js / eval-targets.js), + 1 s silence so the last endpoint fires
  const a = readWav(file); let peak = 0; for (const v of a) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? 0.5 / peak : 0, out = Buffer.alloc((a.length + 16000) * 2);
  for (let i = 0; i < a.length; i++) out.writeInt16LE(Math.round(a[i] * g * 32767), i * 2);
  return out;
}

function session(id, to, audio) { // resolves with every message the server sent for this utterance
  return new Promise((resolve, reject) => {
    const u = new URL(URL_); u.searchParams.set('lang', 'en'); u.searchParams.set('to', to.join(',')); u.searchParams.set('tag', `${LABEL}:${id}`);
    if (args.token) u.searchParams.set('token', args.token);
    const ws = new WebSocket(u), ev = [], t0 = Date.now();
    // Done once the audio is sent, every endpoint has its finals, and the server has been quiet for 5 s (an endpoint can
    // trail the audio by seconds when the server lags). Hard cap 90 s after the last frame: score what arrived.
    let segs = 0, fin = 0, sent = false, idle, cap;
    const done = () => { clearTimeout(idle); clearTimeout(cap); ws.close(); resolve(ev); };
    const check = () => { clearTimeout(idle); if (sent) idle = setTimeout(() => (fin >= segs * to.length ? done() : check()), 5000); };
    ws.on('message', (d) => {
      const m = JSON.parse(d); ev.push(m);
      if (m.type === 'status' && m.level === 'error') { ws.close(); reject(new Error(m.msg)); }
      if (m.type === 'endpoint') segs++;
      if (m.type === 'final') fin++;
      check();
    });
    ws.on('error', reject);
    ws.on('open', () => {
      let i = 0;
      const tick = () => {
        if (i * FRAME * 2 >= audio.length) {
          ws.send('flush'); sent = true; check();
          cap = setTimeout(done, 90000);
          return;
        }
        ws.send(audio.subarray(i * FRAME * 2, (i + 1) * FRAME * 2)); i++;
        setTimeout(tick, Math.max(0, t0 + (i * 80) / SPEED - Date.now()));
      };
      tick();
    });
  });
}

(async () => {
  const items = (await ensureData()).slice(0, N);
  const R = Object.fromEntries(all.map((c) => [c, refs(c)]));
  const at = new Date().toISOString(), detail = {}, rows = [];
  for (const to of passes) {
    const S = Object.fromEntries(to.map((c) => [c, { grey: [], white: [], since: [], ask: [], n: 0 }]));
    for (const c of to) detail[c] = [];
    await session('warmup', to, pcm16(items[items.length - 1].wav)); // loads this pass's Bergamot models; not scored
    for (const [k, it] of items.entries()) {
      const ev = await session(it.id, to, pcm16(it.wav));
      for (const c of to) {
        const r = R[c].get(it.id); if (!r) continue;
        const lastPartial = {}; // seg -> last tr_partial text
        for (const m of ev) if (m.type === 'tr_partial' && m.to === c) { lastPartial[m.seg] = m.text; S[c].ask.push(m.askToSendMs); }
        const fins = ev.filter((m) => m.type === 'final' && m.to === c).sort((a, b) => a.seg - b.seg);
        const segs = ev.filter((m) => m.type === 'endpoint').map((m) => m.seg);
        const grey = segs.map((s) => lastPartial[s] || '').filter(Boolean).join(' '), white = fins.map((m) => m.text).join(' ');
        S[c].grey.push(chrfStats(grey, r)); S[c].white.push(chrfStats(white, r)); S[c].since.push(...fins.map((m) => m.sinceEndpointMs)); S[c].n++;
        detail[c].push({ id: it.id, en: it.en, ref: r, src: fins.map((m) => m.src).join(' '), grey, white, mt: [...new Set(fins.map((m) => m.mt))].join(',') });
      }
      process.stdout.write(`\r${to.join(',')} ${k + 1}/${items.length}   `);
    }
    for (const c of to) {
      const s = S[c], row = { at, label: `live:${LABEL}`, url: URL_.replace(/token=[^&]*/, 'token=…'), target: c, n: s.n, targetsPerSession: to.length, speed: SPEED,
        grey: +chrf(s.grey).toFixed(1), white: +chrf(s.white).toFixed(1),
        finalSinceEndpointMsP50: q(s.since, 0.5), finalSinceEndpointMsP90: q(s.since, 0.9), partialAskToSendMsP50: q(s.ask, 0.5), partialAskToSendMsP90: q(s.ask, 0.9) };
      rows.push(row); fs.appendFileSync(path.join(__dirname, 'eval-results.jsonl'), JSON.stringify(row) + '\n');
    }
    fs.writeFileSync(path.join(__dirname, 'data', `eval-live-${LABEL}.json`), JSON.stringify(detail, null, 1));
  }
  console.log(`\n\n${URL_} (${LABEL}): English speech (FLEURS dev) through /live, chrF vs human reference\n`);
  console.log('target    n   grey  white   final ms p50/p90   partial ms p50/p90');
  for (const r of rows) console.log(`${r.target.padEnd(8)}${String(r.n).padStart(4)}  ${String(r.grey).padStart(5)}  ${String(r.white).padStart(5)}   ${`${r.finalSinceEndpointMsP50}/${r.finalSinceEndpointMsP90}`.padStart(16)}   ${`${r.partialAskToSendMsP50}/${r.partialAskToSendMsP90}`.padStart(18)}`);
  process.exit(0);
})().catch((e) => { console.error('\n' + e.message); process.exit(1); });
