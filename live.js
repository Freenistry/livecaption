// Two-stage live captions into 1-4 target languages, over a WebSocket (/live?lang=en&to=zh-Hans,es,hi).
// English (default) : streaming FastConformer CTC 80 ms -> Bergamot en->x (grey)  |  endpoint -> Parakeet 110M -> white MT
// Other languages   : Nemotron 3.5 streaming (worker) -> Bergamot via English (grey)  |  endpoint -> white MT on Nemotron's text
// White MT is Hy-MT2 where it beat the grey line in eval-targets.js, Bergamot elsewhere (WHITE_HYMT).
// Measured: see README "Live two-stage captions" and "First pilot".
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
// Targets: the 15 pilot languages (README "First pilot") + English for non-English speakers. Value = Hy-MT2 prompt name.
const TARGETS = { 'zh-Hans': 'Simplified Chinese', hi: 'Hindi', es: 'Spanish', ar: 'Arabic', fr: 'French', bn: 'Bengali', pt: 'Portuguese',
  ru: 'Russian', id: 'Indonesian', ur: 'Urdu', de: 'German', ja: 'Japanese', mr: 'Marathi', vi: 'Vietnamese', te: 'Telugu', en: 'English' };
// eval-targets.js: Hy-MT2's white line scored below the grey Bergamot line for hi, bn, ur, mr, te (and is 2-3x slower there),
// so those get Bergamot on Parakeet's text instead.
const WHITE_HYMT = new Set(['zh-Hans', 'es', 'ar', 'fr', 'pt', 'ru', 'id', 'de', 'ja', 'vi', 'en']);
const MAX_TARGETS = 4;
const NO_SPACES = /^(zh|ja)/; // scripts where a partial may stop mid-"word"
// EVAL_LOG=<file> appends one JSON line per endpoint/final (with the session's ?tag=); EVAL_LOG=- writes them to stderr
// (docker compose logs). eval-live.js scores what the client receives; this is the server's own record of the same run.
const EVAL_LOG = process.env.EVAL_LOG;
const evalLog = (o) => {
  if (!EVAL_LOG) return;
  const line = JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n';
  if (EVAL_LOG === '-') process.stderr.write('eval ' + line); else fs.appendFile(EVAL_LOG, line, () => {});
};

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
    fast.ready.then(() => console.log(`live: models ready (/live${multi.available() ? ', spoken: ' + Object.keys(NAMES).filter((l) => l !== 'zh').join(' ') : ', spoken: en'})`),
      (e) => { console.error('live: bergamot failed:', e.message); fast = null; });
  } catch (e) {
    console.warn(`live: disabled: ${e.message}`);
    rec = null;
  }

  const lcp = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return a.slice(0, i); };

  function connect(ws, lang = 'en', to = ['zh-Hans'], tag = '') {
    const send = (o) => {
      if (o.type === 'endpoint' || o.type === 'final') evalLog({ tag, lang, ...o });
      if (ws.readyState === 1) ws.send(JSON.stringify(o));
    };
    const fail = (msg) => { send({ type: 'status', level: 'error', msg }); ws.close(); };
    if (!rec || !fast) return fail('live pipeline not available on this server (see server log)');
    if (!NAMES[lang] || lang === 'zh') return fail(`unsupported language "${lang}"; use one of ${Object.keys(NAMES).filter((l) => l !== 'zh').join(', ')}`);
    to = [...new Set(to)].filter((t) => t !== lang);
    if (!to.length || to.length > MAX_TARGETS || to.some((t) => !TARGETS[t])) return fail(`pick 1-${MAX_TARGETS} targets from ${Object.keys(TARGETS).join(', ')} (not the spoken language)`);
    const dirsOf = Object.fromEntries(to.map((t) => [t, startFastMt.chain(lang, t)]));
    const missing = [...new Set(Object.values(dirsOf).flat())].filter((d) => !fs.existsSync(path.join(MODELS, d)));
    if (lang !== 'en' && !multi.available()) missing.push(`Nemotron (${multi.provider})`);
    if (missing.length) return fail(`missing models: ${missing.join(', ')} (setup.ps1 -Langs / node get-models.js)`);

    let seg = 0, closed = false;

    // Fast path, per target: one Bergamot call in flight, newest partial wins.
    // English (new text every 80 ms) into zh/ja: display only the prefix two consecutive translations agree on, and never
    // shrink what is shown just because the newest one is shorter: this cut retractions on the lab clip from 103 to 21 per 30 s.
    // Other cases: show the newest translation, but let it rewrite (not just extend) the screen at most once per REWRITE_MS
    // (the agree-on-prefix rule held captions back 1-1.5 s when text arrives in bigger steps, and cuts words in spaced scripts).
    const REWRITE_MS = 1000;
    const lanes = Object.fromEntries(to.map((t) => [t, { busy: false, want: null, prev: '', shown: '', seg: 0, lastRewrite: 0 }]));
    async function pump(t) {
      const L = lanes[t];
      if (L.busy || !L.want) return;
      const { seg: s, text, at } = L.want; L.want = null; L.busy = true;
      try {
        const r = await fast.translate(text, dirsOf[t]);
        if (s === L.seg && s === seg) { // segment already finalized: drop
          let next;
          if (lang === 'en' && NO_SPACES.test(t)) {
            const stable = lcp(L.prev, r.out); L.prev = r.out;
            next = stable.startsWith(L.shown) || !L.shown.startsWith(stable) ? stable : L.shown;
          } else if (r.out.startsWith(L.shown)) next = r.out;
          else if (performance.now() - L.lastRewrite > REWRITE_MS) { next = r.out; L.lastRewrite = performance.now(); }
          else next = L.shown;
          if (next !== L.shown) { L.shown = next; send({ type: 'tr_partial', seg: s, to: t, text: next, mtMs: r.ms, askToSendMs: Math.round(performance.now() - at) }); }
        }
      } catch (e) { send({ type: 'status', level: 'error', msg: `fast MT (${t}): ${e.message}` }); }
      L.busy = false; pump(t);
    }
    function partial(text) {
      send({ type: 'src_partial', seg, src: text });
      if (text) for (const t of to) { lanes[t].want = { seg, text, at: performance.now() }; pump(t); }
    }

    // Final path: in order, one segment at a time, targets in parallel. English re-runs Parakeet on the segment audio; other
    // languages reuse the streaming text (Nemotron is already as accurate as Parakeet 110M is on English).
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
        await Promise.all(to.map(async (t) => {
          const b = performance.now();
          let text, mt = WHITE_HYMT.has(t) ? 'hymt' : 'bergamot';
          if (mt === 'hymt') try { text = await hymt(mtUrl, src, TARGETS[t]); } catch (e) { mt = `bergamot (${e.message})`; } // Hy-MT2 down: keep captions coming
          if (text === undefined) text = (await fast.translate(src, dirsOf[t])).out;
          send({ type: 'final', seg: s, to: t, src, text, asrMs, mtMs: Math.round(performance.now() - b), mt, sinceEndpointMs: Math.round(performance.now() - endAt) });
        }));
      }).catch((e) => send({ type: 'status', level: 'error', msg: `final: ${e.message}` }));
    }
    function endpoint(text, audio) {
      if (text) { send({ type: 'endpoint', seg, src: text }); finalize(seg, audio, text, performance.now()); seg++; }
      for (const L of Object.values(lanes)) { L.seg = seg; L.prev = ''; L.shown = ''; L.want = null; }
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

    send({ type: 'status', level: 'info', msg: `connected, ${lang} -> ${to.join(', ')}` });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) { if (String(data) === 'flush') onFlush(); return; } // mic stopped: finalize what we have
      if (data.length % 2 || data.length > MAX_MSG) return;
      const b = Buffer.from(data); // copy -> aligned
      const pcm = new Int16Array(b.buffer, b.byteOffset, b.length >> 1);
      const f = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
      onPcm(f);
    });
    ws.on('close', () => { closed = true; for (const L of Object.values(lanes)) L.want = null; onClose(); });
  }

  return { connect, ready: fast ? fast.ready : Promise.resolve() };
};
module.exports.loadModels = loadModels;
module.exports.hymt = hymt;
module.exports.NAMES = NAMES;
module.exports.TARGETS = TARGETS;
module.exports.MAX_TARGETS = MAX_TARGETS;
