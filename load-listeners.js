// Load test for rooms: 1 speaker streams FLEURS English at real time into a room, N listeners spread over its languages.
// Measures what each listener gets vs what the speaker gets: missing messages and fan-out delay (speaker receive ->
// listener receive, same machine clock). Also samples the server's /api/stats (listeners, memory, processes).
// Usage: node load-listeners.js [base=http://127.0.0.1:3001] [n=2000] [to=es,fr,de,pt,ru,zh-Hans,ja,hi,ar,id] [clips=20] [token=]
//        [via=https://<tunnel> vian=190]  the first vian listeners connect through that URL instead (mixed local + internet);
//        results are also split per path. A Cloudflare quick tunnel allows ~200 concurrent requests, so keep vian under it.
// Needs: the Elixir server (rooms are Elixir-only), FLEURS data (node eval.js once). On Windows, 2000 sockets fit
// the default ephemeral port range; past ~10000 raise it (netsh int ipv4 set dynamicport tcp ...).
const assert = require('assert');
const WebSocket = require('ws');
const { ensureData, readWav } = require('./eval');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const BASE = args.base || 'http://127.0.0.1:3001', N = +(args.n || 2000), CLIPS = +(args.clips || 20);
const TO = (args.to || 'es,fr,de,pt,ru,zh-Hans,ja,hi,ar,id').split(','), ROOM = `load-${process.pid}`;
const WS = BASE.replace(/^http/, 'ws'), FRAME = 1280, VIA = args.via && args.via.replace(/^http/, 'ws'), VIAN = VIA ? +(args.vian || 190) : 0;
const q = (xs, p) => (xs.length ? Math.round([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]) : null);
const key = (m) => `${m.type}|${m.to}|${m.seg}|${m.text}`;
const stats = () => fetch(`${BASE}/api/stats${args.token ? `?token=${args.token}` : ''}`).then((r) => r.json());

function pcm(file) { // -6 dBFS peak, + 1 s silence (as eval-live.js)
  const a = readWav(file); let p = 0; for (const v of a) p = Math.max(p, Math.abs(v));
  const g = p ? 0.5 / p : 0, b = Buffer.alloc((a.length + 16000) * 2);
  for (let i = 0; i < a.length; i++) b.writeInt16LE(Math.round(a[i] * g * 32767), i * 2);
  return b;
}

(async () => {
  const items = (await ensureData()).slice(0, CLIPS);
  const audio = Buffer.concat(items.map((it) => pcm(it.wav)));
  const before = await stats();

  // 1) listeners: connect in batches of 200 (a burst of 2000 handshakes at once is not what we measure here)
  const listeners = [], t0 = performance.now();
  for (let i = 0; i < N; i += 200) {
    await Promise.all(Array.from({ length: Math.min(200, N - i) }, (_, j) => new Promise((res, rej) => {
      const k = i + j, path = k < VIAN ? 'via' : 'base', to = TO[k % TO.length], got = new Map();
      const ws = new WebSocket(`${path === 'via' ? VIA : WS}/listen?room=${ROOM}&to=${encodeURIComponent(to)}`);
      ws.on('message', (d) => { const m = JSON.parse(d); if (m.type !== 'status') got.set(key(m), performance.now()); });
      ws.on('open', () => { listeners.push({ to, path, got, ws, closed: false }); setInterval(() => ws.readyState === 1 && ws.send('ping'), 30000).unref(); res(); }); // as watch.html
      ws.on('close', () => { const l = listeners.find((x) => x.ws === ws); if (l) l.closed = true; });
      ws.on('error', rej);
    })));
  }
  const connectMs = Math.round(performance.now() - t0), during = await stats();
  console.log(`${N} listeners connected in ${connectMs} ms; server: ${JSON.stringify(during)}`);

  // 2) speaker: real-time audio into the room; records when it received each message (the reference)
  const sent = new Map(), url = `${WS}/live?lang=en&to=${TO.join(',')}&room=${ROOM}${args.token ? `&token=${args.token}` : ''}`;
  const sp = new WebSocket(url);
  await new Promise((r, j) => { sp.on('open', r); sp.on('error', j); });
  sp.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'tr_partial' || m.type === 'final') sent.set(key(m), performance.now()); if (m.type === 'status' && m.level === 'error') console.error('speaker:', m.msg); });
  const s0 = Date.now(); let peak = during;
  const sampler = setInterval(() => stats().then((s) => { if (s.memoryMB > peak.memoryMB) peak = s; }).catch(() => {}), 2000);
  for (let i = 0; i * FRAME * 2 < audio.length; i++) {
    sp.send(audio.subarray(i * FRAME * 2, (i + 1) * FRAME * 2));
    const wait = s0 + (i + 1) * 80 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (i % 125 === 0) process.stdout.write(`\rspeaking ${Math.round(i * 0.08)} / ${Math.round(audio.length / 32000)} s   `);
  }
  sp.send('flush');
  await new Promise((r) => setTimeout(r, 30000)); // last finals (Hy-MT2 on 10 targets can queue on a small GPU)
  clearInterval(sampler);

  // 3) compare every listener with the speaker
  const delay = [], perPath = {}; let expected = 0, missing = 0;
  for (const l of listeners) {
    for (const [k, at] of sent) {
      if (k.split('|')[1] !== l.to) continue;
      const P = (perPath[l.path] ||= { listeners: new Set(), expected: 0, missing: 0, d: [] }); P.listeners.add(l); P.expected++;
      expected++;
      const got = l.got.get(k);
      if (got === undefined) { missing++; P.missing++; continue; }
      delay.push(got - at); P.d.push(got - at);
    }
  }
  const finals = [...sent.keys()].filter((k) => k.startsWith('final')).length, partials = sent.size - finals;
  const r = { at: new Date().toISOString(), label: 'listeners', base: BASE, listeners: N, languages: TO.length, audioS: Math.round(audio.length / 32000),
    connectMs, droppedSockets: listeners.filter((l) => l.closed).length, speakerMsgs: { partials, finals },
    delivered: expected - missing, expected, missing,
    fanoutMs: { p50: q(delay, 0.5), p90: q(delay, 0.9), p99: q(delay, 0.99), max: q(delay, 1) },
    ...(VIA && { via: args.via, paths: Object.fromEntries(Object.entries(perPath).map(([k, P]) => [k, { listeners: P.listeners.size,
      dropped: [...P.listeners].filter((l) => l.closed).length, delivered: P.expected - P.missing, expected: P.expected,
      fanoutMs: { p50: q(P.d, 0.5), p90: q(P.d, 0.9), p99: q(P.d, 0.99), max: q(P.d, 1) } }])) }),
    server: { before, during, peak } };
  console.log('\n' + JSON.stringify(r, null, 1));
  require('fs').appendFileSync(require('path').join(__dirname, 'eval-results.jsonl'), JSON.stringify(r) + '\n');
  sp.close(); for (const l of listeners) l.ws.terminate();
  assert(finals > 0, 'speaker got no finals');
  assert.strictEqual(missing, 0, `${missing} of ${expected} messages never reached a listener`);
  assert.strictEqual(r.droppedSockets, 0, 'listener sockets were dropped');
  process.exit(0);
})().catch((e) => { console.error('\n' + (e.stack || e)); process.exit(1); });
