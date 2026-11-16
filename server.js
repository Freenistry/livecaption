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
  const file = path.join(PUBLIC, path.normalize(req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    res.end(data);
  });
});

// --- WebSocket ---------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
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

server.listen(PORT, () => console.log(`http://localhost:${PORT}  (ASR ${ASR_URL}, MT ${MT_URL}, ${SOURCE} -> ${TARGET})`));
