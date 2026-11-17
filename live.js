// Two-stage live captions, English -> Simplified Chinese, over a WebSocket (/live).
// Fast path : streaming FastConformer CTC (80 ms chunks, CPU) -> English partial -> Bergamot (CPU) -> Chinese partial.
// Final path: endpoint -> Parakeet TDT-CTC 110M (CPU) on the segment audio -> Hy-MT2 (llama-server) -> Chinese final.
// Measured on the lab clip: partial work ~40-110 ms per update, final lands ~0.6 s after the speaker pauses.
const path = require('path');
const fs = require('fs');

const MODELS = path.join(__dirname, 'models');
const RATE = 16000;
const MAX_SEG_S = 30; // hard cap on buffered audio per segment (the endpointer cuts at 10 s; this only guards a stuck stream)
const MAX_MSG = 64 * 1024; // one binary frame; the page sends 80 ms = 2560 bytes

// Shared by /live and eval.js so both run the exact same models and endpoint rules. Throws if a model is missing.
function loadModels({ trail = 0.5, maxlen = 10 } = {}) {
  const so = require('sherpa-onnx-node');
  const m = (dir, f) => { const p = path.join(MODELS, dir, f); if (!fs.existsSync(p)) throw new Error(`missing ${p} (run setup.ps1)`); return p; };
  const rec = new so.OnlineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: { nemoCtc: { model: m('streaming-ctc', 'model.int8.onnx') }, tokens: m('streaming-ctc', 'tokens.txt'), numThreads: 2, provider: 'cpu' },
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4,   // silence-only segment
    rule2MinTrailingSilence: trail, // pause after speech: 0.3 split clauses and hurt Hy-MT2, 0.8 adds ~150 ms
    rule3MinUtteranceLength: maxlen, // force a final every maxlen s of continuous speech; eval.js: 10 s beat 5 s (chrF 29.2 vs 26.8)
  });
  const off = new so.OfflineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: { nemoCtc: { model: m('parakeet-110m', 'model.int8.onnx') }, tokens: m('parakeet-110m', 'tokens.txt'), numThreads: 2, provider: 'cpu' },
  });
  m('bergamot-enzh', 'model.enzh.intgemm.alphas.bin');
  const fast = require('./mt-fast')(path.join(MODELS, 'bergamot-enzh'));
  return { rec, off, fast };
}

async function hymt(mtUrl, text) {
  const r = await fetch(`${mtUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: `Translate the following segment into Simplified Chinese, without additional explanation.\n\n${text}` }],
      max_tokens: 384, temperature: 0, stop: ['\n'],
    }),
  });
  if (!r.ok) throw new Error(`MT HTTP ${r.status}`);
  return ((await r.json()).choices?.[0]?.message?.content || '').trim();
}

module.exports = function createLive({ mtUrl }) {
  let rec, off, fast;
  try {
    ({ rec, off, fast } = loadModels());
    fast.ready.then(() => console.log('live: models ready (/live, en -> zh)'), (e) => { console.error('live: bergamot failed:', e.message); fast = null; });
  } catch (e) {
    console.warn(`live: disabled: ${e.message}`);
    rec = null;
  }

  const lcp = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return a.slice(0, i); };

  function connect(ws) {
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
    if (!rec || !fast) { send({ type: 'status', level: 'error', msg: 'live pipeline not available on this server (see server log)' }); return ws.close(); }

    const stream = rec.createStream();
    let seg = 0, segAudio = [], segLen = 0, lastEn = '', closed = false;

    // Fast path: one Bergamot call in flight, newest partial wins.
    // Display only the prefix two consecutive translations agree on, and never shrink what is shown just because
    // the newest one is shorter: this cut retractions on the lab clip from 103 to 21 per 30 s.
    let busy = false, want = null, prevZh = '', shownZh = '', zhSeg = 0;
    async function pump() {
      if (busy || !want) return;
      const { seg: s, text, at } = want; want = null; busy = true;
      try {
        const r = await fast.translate(text);
        if (s === zhSeg && s === seg) { // segment already finalized: drop
          const stable = lcp(prevZh, r.out); prevZh = r.out;
          const next = stable.startsWith(shownZh) || !shownZh.startsWith(stable) ? stable : shownZh;
          if (next !== shownZh) { shownZh = next; send({ type: 'zh_partial', seg: s, zh: next, mtMs: r.ms, askToSendMs: Math.round(performance.now() - at) }); }
        }
      } catch (e) { send({ type: 'status', level: 'error', msg: `fast MT: ${e.message}` }); }
      busy = false; pump();
    }

    // Final path: in order, one at a time.
    let finals = Promise.resolve();
    function finalize(s, audio, text, endAt) {
      finals = finals.then(async () => {
        if (closed) return;
        const a = performance.now();
        const os = off.createStream();
        os.acceptWaveform({ sampleRate: RATE, samples: audio });
        await off.decodeAsync(os);
        const en = off.getResult(os).text.trim() || text;
        const asrMs = Math.round(performance.now() - a);
        const b = performance.now();
        let zh, mt = 'hymt';
        try { zh = await hymt(mtUrl, en); } catch (e) { zh = (await fast.translate(en)).out; mt = `bergamot (${e.message})`; } // Hy-MT2 down: keep captions coming
        send({ type: 'final', seg: s, en, zh, asrMs, mtMs: Math.round(performance.now() - b), mt, sinceEndpointMs: Math.round(performance.now() - endAt) });
      }).catch((e) => send({ type: 'status', level: 'error', msg: `final: ${e.message}` }));
    }

    function endSegment(text) {
      const audio = new Float32Array(segLen); let o = 0;
      for (const c of segAudio) { audio.set(c, o); o += c.length; }
      if (text) { send({ type: 'endpoint', seg, en: text }); finalize(seg, audio, text, performance.now()); seg++; }
      rec.reset(stream); segAudio = []; segLen = 0; lastEn = '';
      zhSeg = seg; prevZh = ''; shownZh = ''; want = null;
    }

    send({ type: 'status', level: 'info', msg: 'connected, en -> zh (two-stage)' });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) { if (String(data) === 'flush' && segLen) endSegment(lastEn); return; } // mic stopped: finalize what we have
      if (data.length % 2 || data.length > MAX_MSG) return;
      const b = Buffer.from(data); // copy -> aligned
      const pcm = new Int16Array(b.buffer, b.byteOffset, b.length >> 1);
      const f = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
      // ponytail: decode runs on the main thread (~1 ms typical, ~45 ms worst per 80 ms chunk) - fine for a few viewers;
      // move to a worker per stream if many sessions share one box.
      stream.acceptWaveform({ sampleRate: RATE, samples: f });
      while (rec.isReady(stream)) rec.decode(stream);
      segAudio.push(f); segLen += f.length;
      const text = rec.getResult(stream).text.trim();
      if (text !== lastEn) {
        lastEn = text;
        send({ type: 'en_partial', seg, en: text });
        if (text) { want = { seg, text, at: performance.now() }; pump(); }
      }
      if (rec.isEndpoint(stream) || segLen > MAX_SEG_S * RATE) endSegment(text);
    });
    ws.on('close', () => { closed = true; want = null; });
  }

  return { connect };
};
module.exports.loadModels = loadModels;
module.exports.hymt = hymt;
