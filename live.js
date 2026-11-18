// Two-stage live captions -> Simplified Chinese, over a WebSocket (/live?lang=xx).
// English (default) : streaming FastConformer CTC 80 ms -> Bergamot en->zh (grey)  |  endpoint -> Parakeet 110M -> Hy-MT2 (white)
// Other languages   : Nemotron 3.5 streaming 560 ms (worker) -> Bergamot via English (grey)  |  endpoint -> Hy-MT2 on Nemotron's text (white)
// Measured: see README "Live two-stage captions".
const path = require('path');
const fs = require('fs');
const multi = require('./asr-multi');
const startFastMt = require('./mt-fast');

const MODELS = path.join(__dirname, 'models');
const RATE = 16000;
const MAX_SEG_S = 30; // hard cap on buffered audio per segment (the endpointer cuts at 10 s; this only guards a stuck stream)
const MAX_MSG = 64 * 1024; // one binary frame; the page sends 80 ms = 2560 bytes
// Names Hy-MT2 understands in its prompt, for the languages /live can hear (Nemotron ∩ Hy-MT2).
const NAMES = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', tr: 'Turkish', ru: 'Russian',
  ar: 'Arabic', hi: 'Hindi', ja: 'Japanese', ko: 'Korean', vi: 'Vietnamese', uk: 'Ukrainian', pl: 'Polish', cs: 'Czech', zh: 'Chinese' };

// Shared by /live and eval.js so both run the exact same English models and endpoint rules. Throws if a model is missing.
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
  const fast = startFastMt(MODELS);
  return { rec, off, fast };
}

async function hymt(mtUrl, text, target = 'Simplified Chinese') { // Hy-MT2 detects the source language itself
  const r = await fetch(`${mtUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: `Translate the following segment into ${target}, without additional explanation.\n\n${text}` }],
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
    if (multi.available()) multi.preload().then(() => console.log(`live: Nemotron ready on ${multi.provider} (?lang=)`), (e) => console.error('live: Nemotron failed:', e.message));
    fast.ready.then(() => console.log(`live: models ready (/live, en -> zh${multi.available() ? '; ?lang= for ' + Object.keys(NAMES).filter((l) => l !== 'en').join(' ') : ''})`),
      (e) => { console.error('live: bergamot failed:', e.message); fast = null; });
  } catch (e) {
    console.warn(`live: disabled: ${e.message}`);
    rec = null;
  }

  const lcp = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return a.slice(0, i); };

  function connect(ws, lang = 'en') {
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
    if (!rec || !fast) { send({ type: 'status', level: 'error', msg: 'live pipeline not available on this server (see server log)' }); return ws.close(); }
    if (!NAMES[lang] || lang === 'zh') { send({ type: 'status', level: 'error', msg: `unsupported language "${lang}"; use one of ${Object.keys(NAMES).filter((l) => l !== 'zh').join(', ')}` }); return ws.close(); }
    const dirs = startFastMt.chain(lang, 'zh-Hans');
    if (lang !== 'en') {
      const missing = [...dirs.filter((d) => !fs.existsSync(path.join(MODELS, d))), ...(multi.available() ? [] : [`Nemotron (${multi.provider})`])];
      if (missing.length) { send({ type: 'status', level: 'error', msg: `missing models for ${lang}: ${missing.join(', ')} (node get-models.js ${lang})` }); return ws.close(); }
    }

    let seg = 0, closed = false;

    // Fast path: one Bergamot call in flight, newest partial wins.
    // English (new text every 80 ms): display only the prefix two consecutive translations agree on, and never shrink
    // what is shown just because the newest one is shorter: this cut retractions on the lab clip from 103 to 21 per 30 s.
    // Other languages (new text every 560 ms): that rule held Chinese back 1-1.5 s, so show the newest translation, but
    // let it rewrite (not just extend) what is on screen at most once per REWRITE_MS.
    const REWRITE_MS = 1000;
    let busy = false, want = null, prevZh = '', shownZh = '', zhSeg = 0, lastRewrite = 0;
    async function pump() {
      if (busy || !want) return;
      const { seg: s, text, at } = want; want = null; busy = true;
      try {
        const r = await fast.translate(text, dirs);
        if (s === zhSeg && s === seg) { // segment already finalized: drop
          let next;
          if (lang === 'en') {
            const stable = lcp(prevZh, r.out); prevZh = r.out;
            next = stable.startsWith(shownZh) || !shownZh.startsWith(stable) ? stable : shownZh;
          } else if (r.out.startsWith(shownZh)) next = r.out;
          else if (performance.now() - lastRewrite > REWRITE_MS) { next = r.out; lastRewrite = performance.now(); }
          else next = shownZh;
          if (next !== shownZh) { shownZh = next; send({ type: 'zh_partial', seg: s, zh: next, mtMs: r.ms, askToSendMs: Math.round(performance.now() - at) }); }
        }
      } catch (e) { send({ type: 'status', level: 'error', msg: `fast MT: ${e.message}` }); }
      busy = false; pump();
    }
    function partial(text) {
      send({ type: 'en_partial', seg, en: text });
      if (text) { want = { seg, text, at: performance.now() }; pump(); }
    }

    // Final path: in order, one at a time. English re-runs Parakeet on the segment audio; other languages reuse the
    // streaming text (Nemotron is already as accurate as Parakeet 110M is on English, and a second 0.6B pass costs 1.5-2 s).
    let finals = Promise.resolve();
    function finalize(s, audio, text, endAt) {
      finals = finals.then(async () => {
        if (closed) return;
        const a = performance.now();
        let src = text;
        if (lang === 'en') {
          const os = off.createStream();
          os.acceptWaveform({ sampleRate: RATE, samples: audio });
          await off.decodeAsync(os);
          src = off.getResult(os).text.trim() || text;
        }
        const asrMs = Math.round(performance.now() - a);
        const b = performance.now();
        let zh, mt = 'hymt';
        try { zh = await hymt(mtUrl, src); } catch (e) { zh = (await fast.translate(src, dirs)).out; mt = `bergamot (${e.message})`; } // Hy-MT2 down: keep captions coming
        send({ type: 'final', seg: s, en: src, zh, asrMs, mtMs: Math.round(performance.now() - b), mt, sinceEndpointMs: Math.round(performance.now() - endAt) });
      }).catch((e) => send({ type: 'status', level: 'error', msg: `final: ${e.message}` }));
    }
    function endpoint(text, audio) {
      if (text) { send({ type: 'endpoint', seg, en: text }); finalize(seg, audio, text, performance.now()); seg++; }
      zhSeg = seg; prevZh = ''; shownZh = ''; want = null;
    }

    // Audio in: English decodes inline (~1 ms per 80 ms chunk); other languages go to a Nemotron worker.
    let onPcm, onFlush, onClose = () => {};
    if (lang === 'en') {
      const stream = rec.createStream();
      let segAudio = [], segLen = 0, lastEn = '';
      const end = (text) => {
        const audio = new Float32Array(segLen); let o = 0;
        for (const c of segAudio) { audio.set(c, o); o += c.length; }
        rec.reset(stream); segAudio = []; segLen = 0; lastEn = '';
        endpoint(text, audio);
      };
      // ponytail: English decode runs on the main thread (~1 ms typical, ~45 ms worst per 80 ms chunk) - fine for a few
      // viewers; asr-multi.js shows the worker version if many sessions share one box.
      onPcm = (f) => {
        stream.acceptWaveform({ sampleRate: RATE, samples: f });
        while (rec.isReady(stream)) rec.decode(stream);
        segAudio.push(f); segLen += f.length;
        const text = rec.getResult(stream).text.trim();
        if (text !== lastEn) { lastEn = text; partial(text); }
        if (rec.isEndpoint(stream) || segLen > MAX_SEG_S * RATE) end(text);
      };
      onFlush = () => { if (segLen) end(lastEn); };
    } else {
      const asr = multi.open(lang, (m) => {
        if (m.type === 'partial') partial(m.text);
        else if (m.type === 'endpoint') endpoint(m.text); // no audio: the final reuses the streaming text
        else if (m.type === 'error') send({ type: 'status', level: 'error', msg: `asr: ${m.msg}` });
      });
      const queued = [];
      let ready = false;
      asr.ready.then(() => { ready = true; for (const f of queued.splice(0)) asr.push(f); send({ type: 'status', level: 'info', msg: `${NAMES[lang]} model loaded` }); },
        (e) => send({ type: 'status', level: 'error', msg: `asr: ${e.message}` }));
      onPcm = (f) => (ready ? asr.push(f) : queued.length < 200 && queued.push(f)); // ~16 s of audio while the model loads
      onFlush = () => ready && asr.flush();
      onClose = () => asr.close();
    }

    send({ type: 'status', level: 'info', msg: `connected, ${lang} -> zh (two-stage)` });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) { if (String(data) === 'flush') onFlush(); return; } // mic stopped: finalize what we have
      if (data.length % 2 || data.length > MAX_MSG) return;
      const b = Buffer.from(data); // copy -> aligned
      const pcm = new Int16Array(b.buffer, b.byteOffset, b.length >> 1);
      const f = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
      onPcm(f);
    });
    ws.on('close', () => { closed = true; want = null; onClose(); });
  }

  return { connect };
};
module.exports.loadModels = loadModels;
module.exports.hymt = hymt;
module.exports.NAMES = NAMES;
