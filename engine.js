// The /live pipeline as a child process of the Elixir server (server_ex/), spoken to over stdin/stdout.
// The models (sherpa-onnx, Bergamot WASM) only have Node bindings, so Elixir owns HTTP + WebSockets and this owns compute.
// Frames both ways: 4-byte big-endian length, then  [kind u8][session u32 BE][payload]  (Erlang {:packet, 4}).
//   in : 1 open {lang, to, tag} JSON | 2 PCM16 audio | 3 flush | 4 close
//   out: 1 JSON message for the browser | 2 session closed | 3 (session 0) languages JSON, sent once at startup
const fs = require('fs'), path = require('path'), { EventEmitter } = require('events');
const { NAMES, TARGETS, MAX_TARGETS } = require('./live');
const { chain } = require('./mt-fast');
const multi = require('./asr-multi');

const out = (kind, sid, payload = Buffer.alloc(0)) => {
  const b = Buffer.alloc(9 + payload.length);
  b.writeUInt32BE(5 + payload.length, 0); b[4] = kind; b.writeUInt32BE(sid, 5); payload.copy(b, 9);
  process.stdout.write(b);
};
console.log = console.warn = (...a) => process.stderr.write(a.join(' ') + '\n'); // stdout carries frames only

const live = require('./live')({ mtUrl: process.env.MT_URL || 'http://127.0.0.1:8099' });
const has = (d) => fs.existsSync(path.join(__dirname, 'models', d));
const announce = () => out(3, 0, Buffer.from(JSON.stringify({
  spoken: Object.entries(NAMES).filter(([c]) => c !== 'zh').map(([code, name]) => ({ code, name, ready: code === 'en' || (multi.available() && has(chain(code, 'en')[0])) })),
  targets: Object.entries(TARGETS).map(([code, name]) => ({ code, name: name.replace('Simplified ', ''), ready: code === 'en' || chain('en', code).every(has) })),
  maxTargets: MAX_TARGETS,
})));
live.ready.then(announce, announce); // only once models are loaded: serve.sh waits on /api/languages
const sessions = new Map(); // sid -> fake ws that live.connect() talks to

function open(sid, { lang, to, tag }) {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = (s) => out(1, sid, Buffer.from(s));
  ws.close = () => { if (ws.readyState !== 1) return; ws.readyState = 3; sessions.delete(sid); out(2, sid); ws.emit('close'); };
  sessions.set(sid, ws);
  live.connect(ws, String(lang || 'en'), String(to || 'zh-Hans').split(','), String(tag || '').slice(0, 64));
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
    const n = buf.readUInt32BE(0), kind = buf[4], sid = buf.readUInt32BE(5), body = buf.subarray(9, 4 + n);
    buf = buf.subarray(4 + n);
    const ws = sessions.get(sid);
    try {
      if (kind === 1 && !ws) open(sid, JSON.parse(body));
      else if (kind === 2 && ws) ws.emit('message', Buffer.from(body), true);
      else if (kind === 3 && ws) ws.emit('message', Buffer.from('flush'), false);
      else if (kind === 4 && ws) { ws.readyState = 3; sessions.delete(sid); ws.emit('close'); }
    } catch (e) { out(1, sid, Buffer.from(JSON.stringify({ type: 'status', level: 'error', msg: e.message }))); }
  }
});
process.stdin.on('end', () => process.exit(0)); // Elixir went away: so do we (and asr-multi's child, via disconnect)
