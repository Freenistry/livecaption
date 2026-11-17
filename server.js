// Live translated captions POC: browser PCM16 -> energy VAD -> whisper-server -> llama-server -> captions.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3000;
const ASR_URL = process.env.ASR_URL || 'http://127.0.0.1:8081';
const MT_URL = process.env.MT_URL || 'http://127.0.0.1:8099';
const TARGET = process.env.TARGET_LANG || 'German';
const SOURCE = process.env.SOURCE_LANG || 'auto';
const RATE = 16000;
const FRAME = RATE / 50; // 20 ms
const PUBLIC = path.join(__dirname, 'public');
const APP_TOKEN = process.env.APP_TOKEN || ''; // empty = open, fine for localhost
const authed = (req) => !APP_TOKEN || req.headers['x-app-token'] === APP_TOKEN;

// --- VAD -------------------------------------------------------------------
const END_SIL_FRAMES = 35;    // 700 ms
const MAX_FRAMES = 400;       // 8 s
const MIN_SPEECH_FRAMES = 20; // 400 ms
const PREROLL_FRAMES = 10;    // 200 ms kept before onset
const ABS_FLOOR_DB = -45;     // threshold never below this (dBFS)

function frameDb(pcm, off) {
  let s = 0;
  for (let i = off; i < off + FRAME; i++) { const v = pcm[i] / 32768; s += v * v; }
  return 10 * Math.log10(s / FRAME + 1e-10);
}

// Feed Int16Array chunks; calls onSegment(Int16Array) for each completed utterance.
function createVad(onSegment) {
  let rest = new Int16Array(0);
  let noise = -60, frames = [], pre = [], silent = 0, speaking = false;

  function close() {
    const voiced = frames.length - silent;
    if (voiced >= MIN_SPEECH_FRAMES) {
      const out = new Int16Array(frames.length * FRAME);
      frames.forEach((f, i) => out.set(f, i * FRAME));
      onSegment(out);
    }
    frames = []; silent = 0; speaking = false;
  }

  return {
    push(chunk) {
      const pcm = new Int16Array(rest.length + chunk.length);
      pcm.set(rest); pcm.set(chunk, rest.length);
      let off = 0;
      for (; off + FRAME <= pcm.length; off += FRAME) {
        const f = pcm.slice(off, off + FRAME);
        const db = frameDb(pcm, off);
        const isSpeech = db > Math.max(noise + 6, ABS_FLOOR_DB);
        if (!speaking) {
          // noise floor: drop fast, rise slowly, only while not in speech
          noise = db < noise ? db : noise * 0.98 + db * 0.02;
          pre.push(f); if (pre.length > PREROLL_FRAMES) pre.shift();
          if (isSpeech) { speaking = true; frames = pre; pre = []; silent = 0; }
          continue;
        }
        frames.push(f);
        silent = isSpeech ? 0 : silent + 1;
        if (silent >= END_SIL_FRAMES || frames.length >= MAX_FRAMES) close();
      }
      rest = pcm.slice(off);
    },
    flush() { if (speaking) close(); },
  };
}

// --- ASR / MT ----------------------------------------------------------------
function wav(pcm) {
  const h = Buffer.alloc(44), n = pcm.length * 2;
  h.write('RIFF', 0); h.writeUInt32LE(36 + n, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, n)]);
}

async function asr(pcm) {
  const fd = new FormData();
  fd.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'seg.wav');
  fd.append('response_format', 'json');
  fd.append('temperature', '0');
  fd.append('language', SOURCE);
  const r = await fetch(`${ASR_URL}/inference`, { method: 'POST', body: fd }).catch(() => { throw new Error(`ASR backend unreachable at ${ASR_URL}`); });
  if (!r.ok) throw new Error(`ASR HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`ASR: ${j.error}`);
  // strip whisper non-speech tags like [BLANK_AUDIO], (music)
  return (j.text || '').replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

async function mt(src) {
  const r = await fetch(`${MT_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: `Translate the following text into ${TARGET}. Output only the translation, no explanation.\n\n${src}` }],
      max_tokens: 256, temperature: 0,
    }),
  }).catch(() => { throw new Error(`MT backend unreachable at ${MT_URL}`); });
  if (!r.ok) throw new Error(`MT HTTP ${r.status}`);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || '').trim();
}

// Same request, but streams token deltas as they are generated.
// No pacing is applied: what the caller sees is what the model actually emitted, when it emitted it.
async function mtStream(src, onDelta) {
  const r = await fetch(`${MT_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: `Translate the following text into ${TARGET}. Output only the translation, no explanation.\n\n${src}` }],
      max_tokens: 256, temperature: 0, stream: true,
    }),
  }).catch(() => { throw new Error(`MT backend unreachable at ${MT_URL}`); });
  if (!r.ok || !r.body) throw new Error(`MT HTTP ${r.status}`);

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const d = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (d) { out += d; onDelta(d); }
      } catch {}
    }
  }
  return out.trim();
}

const MAX_WAV = 44 + 10 * RATE * 2; // 10 s; client caps segments at 8 s
// 16 kHz mono PCM16 WAV -> Int16Array, or null. Walks RIFF chunks (fmt may be 16 or 18+ bytes).
function parseWav(b) {
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt = false;
  for (let o = 12; o + 8 <= b.length; o += 8 + b.readUInt32LE(o + 4) + (b.readUInt32LE(o + 4) & 1)) {
    const id = b.toString('ascii', o, o + 4);
    if (id === 'fmt ') fmt = b.readUInt16LE(o + 8) === 1 && b.readUInt16LE(o + 10) === 1 && b.readUInt32LE(o + 12) === RATE && b.readUInt16LE(o + 22) === 16;
    if (id === 'data') {
      if (!fmt) return null;
      const c = Buffer.from(b.subarray(o + 8, o + 8 + (Math.min(b.readUInt32LE(o + 4), b.length - o - 8) & ~1))); // copy -> aligned
      return new Int16Array(c.buffer, c.byteOffset, c.length >> 1);
    }
  }
  return null;
}

let nextId = 1;
async function processSegment(pcm, t0 = Date.now()) {
  const a = Date.now();
  const src = await asr(pcm);
  const asrMs = Date.now() - a;
  if (!src) return null;
  const b = Date.now();
  const dst = await mt(src);
  const mtMs = Date.now() - b;
  return { type: 'segment', id: nextId++, src, dst, asrMs, mtMs, totalMs: Date.now() - t0, audioMs: pcm.length / 16 };
}

// --- HTTP --------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/selftest') {
    if (!authed(req)) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
    const segs = [];
    const vad = createVad((s) => segs.push(s));
    vad.push(pcm); vad.flush();
    try {
      const out = [];
      for (const s of segs) { const r = await processSegment(s); if (r) out.push(r); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ vadSegments: segs.length, segments: out }));
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ backend: 'node', target: TARGET, ok: true }));
  }
  if (req.method === 'POST' && req.url === '/api/segment/stream') {
    // Same input as /api/segment, but emits server-sent events so the page can render tokens as they arrive.
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!authed(req)) return json(401, { error: 'unauthorized' });
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_WAV) return json(413, { error: 'too large' }); chunks.push(c); }
    const pcm = parseWav(Buffer.concat(chunks));
    if (!pcm) return json(400, { error: 'expected 16 kHz mono PCM16 WAV' });

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const ev = (o) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`); };
    const t0 = Date.now();
    try {
      const src = await asr(pcm);
      const asrMs = Date.now() - t0;
      ev({ type: 'src', src, asrMs });
      if (!src) { ev({ type: 'done', src: '', dst: '', asrMs, mtMs: 0, totalMs: Date.now() - t0, audioMs: Math.round(pcm.length / 16) }); }
      else {
        const b = Date.now();
        const dst = await mtStream(src, (d) => ev({ type: 'delta', d }));
        ev({ type: 'done', src, dst, asrMs, mtMs: Date.now() - b, totalMs: Date.now() - t0, audioMs: Math.round(pcm.length / 16) });
      }
    } catch (e) { ev({ type: 'error', error: e.message }); }
    res.end();
    return;
  }
  if (req.method === 'POST' && req.url === '/api/segment') {
    // WAV in (16 kHz mono PCM16, canonical 44-byte header), no VAD; same shape as the Worker
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!authed(req)) return json(401, { error: 'unauthorized' });
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_WAV) return json(413, { error: 'too large' }); chunks.push(c); }
    const pcm = parseWav(Buffer.concat(chunks));
    if (!pcm) return json(400, { error: 'expected 16 kHz mono PCM16 WAV' });
    try {
      const t0 = Date.now();
      const src = await asr(pcm);
      const asrMs = Date.now() - t0;
      const b = Date.now();
      const dst = src ? await mt(src) : '';
      json(200, { src, dst, asrMs, mtMs: src ? Date.now() - b : 0, totalMs: Date.now() - t0, audioMs: Math.round(pcm.length / 16) });
    } catch (e) { json(502, { error: e.message }); }
    return;
  }
  const file = path.join(PUBLIC, path.normalize(req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    res.end(data);
  });
});

// --- WebSocket ---------------------------------------------------------------
// One server for both paths: two WebSocketServers on one http server would 400 each other's upgrades.
const wss = new WebSocketServer({
  server,
  verifyClient: (info, cb) => {
    let u; try { u = new URL(info.req.url, 'http://localhost'); } catch { return cb(false, 400); }
    if (u.pathname !== '/ws' && u.pathname !== '/live') return cb(false, 404);
    cb(!APP_TOKEN || u.searchParams.get('token') === APP_TOKEN, 401, 'unauthorized');
  },
});
wss.on('connection', (ws, req) => {
  if (req.url.startsWith('/live')) return live.connect(ws);
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  let busy = false, pending = null; // ponytail: 1-slot queue; newer segment replaces an unprocessed one (drop backlog, never drift)

  async function run(pcm, t0) {
    busy = true;
    try {
      const r = await processSegment(pcm, t0);
      if (r) send(r);
    } catch (e) {
      send({ type: 'status', level: 'error', msg: e.message });
    }
    busy = false;
    if (pending) { const p = pending; pending = null; run(p.pcm, p.t0); }
  }

  const vad = createVad((pcm) => {
    if (!busy) return run(pcm, Date.now());
    if (pending) send({ type: 'status', level: 'warn', msg: 'dropped a segment (falling behind)' });
    pending = { pcm, t0: Date.now() };
  });

  send({ type: 'status', level: 'info', msg: `connected, ${SOURCE} -> ${TARGET}` });
  ws.on('message', (data, isBinary) => {
    if (!isBinary || data.length % 2) return;
    const b = Buffer.from(data); // copy -> aligned
    vad.push(new Int16Array(b.buffer, b.byteOffset, b.length >> 1));
  });
  ws.on('close', () => { pending = null; });
});

const live = require('./live')({ mtUrl: MT_URL });
server.listen(PORT, () =>console.log(`http://localhost:${PORT}  (ASR ${ASR_URL}, MT ${MT_URL}, ${SOURCE} -> ${TARGET})`));
