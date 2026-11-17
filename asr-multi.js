// Multilingual streaming ASR for /live: Nemotron 3.5 ASR streaming 0.6B (32 languages), in one shared child process
// that loads the model once and serves every connection's stream. A child process, not a worker thread: Windows loads one
// onnxruntime.dll per process, and the English models already loaded the CPU-only one (the CUDA one then silently falls back).
//   GPU (ASR_GPU=1): fp32 80 ms model via sherpa-onnx's CUDA build, ~40 ms per 80 ms chunk on a GTX 1060, ~3.7 GB VRAM.
//   CPU (default)  : int8 560 ms model, ~0.5x real time on 2 threads. The int8 80 ms model needs 2.4x real time on CPU.
const { fork } = require('child_process');
const path = require('path'), fs = require('fs');

const RATE = 16000, TRAIL = 0.5, MAXLEN = 10, MAX_SEG_S = 30;
const GPU_LIB = path.join(__dirname, 'vendor', 'sherpa-cuda'); // addon + onnxruntime CUDA build + CUDA 12.8/cuDNN 9 DLLs
const MODEL = process.env.ASR_GPU === '1'
  ? { dir: path.join(__dirname, 'models', 'nemotron-80-fp32'), suffix: '.onnx', provider: 'cuda' }
  : { dir: path.join(__dirname, 'models', 'nemotron-560'), suffix: '.int8.onnx', provider: 'cpu' };
// Nemotron's language tags (tokens.txt); the stream option takes the bare code.
const LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'tr', 'ru', 'ar', 'hi', 'ja', 'ko', 'vi', 'uk', 'pl', 'sv', 'cs', 'nb', 'da', 'bg', 'fi', 'hr', 'sk', 'zh', 'hu', 'ro', 'et'];

if (require.main !== module) {
  const available = () => fs.existsSync(path.join(MODEL.dir, `encoder${MODEL.suffix}`)) && (MODEL.provider === 'cpu' || fs.existsSync(path.join(GPU_LIB, 'sherpa-onnx.node')));
  let w, ready, next = 0;
  const handlers = new Map();
  function boot() {
    if (w) return ready;
    const env = MODEL.provider === 'cuda' ? { ...process.env, PATH: `${GPU_LIB};${process.env.PATH}` } : process.env; // CUDA DLLs resolve via PATH
    w = fork(__filename, [], { env, serialization: 'advanced' }); // advanced: Float32Arrays survive the trip
    ready = new Promise((res, rej) => { w.once('message', res); w.once('error', rej); w.once('exit', (c) => rej(new Error(`ASR process exited (${c})`))); });
    ready.then(() => w.on('message', (m) => handlers.get(m.id)?.(m)), () => {});
    const fail = (msg) => { for (const h of handlers.values()) h({ type: 'error', msg }); w = null; };
    w.on('error', (e) => fail(e.message)); w.on('exit', (c) => fail(`ASR process exited (${c})`));
    return ready;
  }
  // Returns { ready, push(Float32Array), flush(), close() }; calls on(msg) with
  // { type: 'partial', text } | { type: 'endpoint', text } | { type: 'error', msg }.
  function open(lang, on) {
    boot();
    const id = ++next; handlers.set(id, on);
    w.send({ op: 'open', id, lang });
    return {
      ready,
      push: (f) => w?.send({ op: 'pcm', id, f }),
      flush: () => w?.send({ op: 'flush', id }),
      close: () => { handlers.delete(id); w?.send({ op: 'close', id }); },
    };
  }
  module.exports = { open, preload: boot, available, LANGS, provider: MODEL.provider };
} else {
  const { dir, suffix, provider } = MODEL;
  const post = (m) => process.send(m);
  if (provider === 'cuda') { // the npm addon is CPU-only; swap in the same addon next to the CUDA onnxruntime
    const shim = require.resolve('sherpa-onnx-node/addon.js');
    require.cache[shim] = { id: shim, filename: shim, loaded: true, exports: require(path.join(GPU_LIB, 'sherpa-onnx.node')) };
  }
  const so = require('sherpa-onnx-node');
  const f = (k) => path.join(dir, `${k}${suffix}`);
  const rec = new so.OnlineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 128 },
    modelConfig: { transducer: { encoder: f('encoder'), decoder: f('decoder'), joiner: f('joiner') }, tokens: path.join(dir, 'tokens.txt'), numThreads: 2, provider },
  });
  // Segmenting without reset(): reset() drops the audio still inside the model (~0.3 s, words not yet emitted), so a cut
  // on the 80 ms model lost "es el quinto CEP" mid-sentence. Instead the stream runs on, its text only grows, and a
  // segment is the text added since the last cut. Cut after TRAIL s with no new text, or MAXLEN s into a segment.
  // ponytail: reset (to bound the stream's memory, ~115 MB/h of features) only after 30 s of no new text, when nothing
  // can be in flight. Upgrade: a periodic reset at a long pause if streams run for hours without one.
  const clean = (t) => t.replace(/<[^>]*>/g, '').trim(); // drop language tags the model may emit
  const streams = new Map(); // id -> { s, at, from, segAt, changedAt, last }  (sample counts and text offsets)
  // Trailing punctuation arrives after the words, so it would start the next segment (". El resultado", or a lone ".");
  // strip leading punctuation from a segment instead. Ponytail: a lone trailing "." just gets dropped.
  const seg = (full, from) => full.slice(from).replace(/^[\s\p{P}]+/u, '').trim();
  const cut = (id, st, full) => {
    const text = seg(full, st.from);
    if (text) post({ id, type: 'endpoint', text });
    st.from = full.length; st.segAt = st.at; st.last = '';
  };
  process.on('message', ({ op, id, lang, f: pcm }) => {
    if (op === 'open') { const s = rec.createStream(); s.setOption('language', lang); streams.set(id, { s, at: 0, from: 0, segAt: 0, changedAt: 0, last: '' }); return; }
    const st = streams.get(id); if (!st) return;
    if (op === 'close') { streams.delete(id); return; }
    if (op === 'flush') { st.s.inputFinished(); while (rec.isReady(st.s)) rec.decode(st.s); cut(id, st, clean(rec.getResult(st.s).text)); streams.delete(id); return; }
    st.s.acceptWaveform({ sampleRate: RATE, samples: pcm });
    while (rec.isReady(st.s)) rec.decode(st.s);
    st.at += pcm.length;
    const full = clean(rec.getResult(st.s).text), text = seg(full, st.from);
    if (text !== st.last) { st.last = text; st.changedAt = st.at; post({ id, type: 'partial', text }); }
    if (text && (st.at - st.changedAt >= TRAIL * RATE || st.at - st.segAt >= MAXLEN * RATE)) cut(id, st, full);
    else if (!text && st.at - st.changedAt > MAX_SEG_S * RATE) { rec.reset(st.s); st.from = 0; st.segAt = st.changedAt = st.at; }
  });
  // warm-up: the first decodes on CUDA take seconds (kernel selection); do them before anyone is listening
  const w = rec.createStream(); w.setOption('language', 'en');
  const z = new Float32Array(RATE * 2).map((_, i) => 0.05 * Math.sin(i / 9));
  for (let i = 0; i < z.length; i += 1280) { w.acceptWaveform({ sampleRate: RATE, samples: z.subarray(i, i + 1280) }); while (rec.isReady(w)) rec.decode(w); }
  post('ready');
  process.on('disconnect', () => process.exit(0)); // server gone: do not linger holding VRAM
}
