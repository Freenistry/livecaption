// Bergamot (Firefox Translations), WASM, one worker thread per model so its ~50 ms per call never blocks audio decoding.
// Models live in models/bergamot-<pair>/ (node get-models.js fetches them). Non-English pairs chain through English.
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs'), path = require('path'), vm = require('vm');

// en + zh-Hans -> bergamot-enzh (the name setup.ps1 has always used), es + en -> bergamot-esen
const pairDir = (from, to) => `bergamot-${(from + to).toLowerCase().replace('-hans', '')}`;
// Firefox only ships pairs to and from English, so anything else pivots through it.
const chain = (src, tgt) => (src === 'en' || tgt === 'en' ? [pairDir(src, tgt)] : [pairDir(src, 'en'), pairDir('en', tgt)]);

if (isMainThread) {
  // ponytail: keeps the 8 most recently used models (4 targets + the source->en pivot, with room to switch) (~50-70 MB file, a few hundred MB loaded, each). One WASM heap
  // holding several models aborted after evict + reload (heap fragmentation), so each model gets its own worker and
  // eviction is worker.terminate(). Raise MAX_MODELS if RAM allows and many languages are live at once.
  const MAX_MODELS = 12; // 10 targets per session + headroom
  // Returns { ready: Promise, translate(text, dirs) -> Promise<{ out, ms }> }
  module.exports = function startFastMt(root, preload = ['bergamot-enzh']) {
    const workers = new Map(); // dir -> { call(text) -> Promise<{out, ms}>, ready, w }
    function get(dir) {
      if (workers.has(dir)) { const h = workers.get(dir); workers.delete(dir); workers.set(dir, h); return h; } // mark recent
      if (!/^bergamot-[a-z]+$/.test(dir) || !fs.existsSync(path.join(root, dir))) throw new Error(`missing ${path.join(root, dir)} (node get-models.js <lang>)`);
      while (workers.size >= MAX_MODELS) { const [old, h] = workers.entries().next().value; workers.delete(old); h.w.terminate(); }
      const w = new Worker(__filename, { workerData: path.join(root, dir) });
      const waiting = new Map(); let next = 0;
      const fail = (e) => { for (const p of waiting.values()) p.reject(e); waiting.clear(); workers.get(dir)?.w === w && workers.delete(dir); };
      const ready = new Promise((res, rej) => { w.once('message', res); w.once('error', rej); });
      w.on('message', (m) => { const p = m && waiting.get(m.id); if (!p) return; waiting.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m); });
      w.on('error', fail);
      w.on('exit', () => fail(new Error(`${dir} unloaded`)));
      const h = { w, ready, call: (text) => ready.then(() => new Promise((resolve, reject) => { const id = ++next; waiting.set(id, { resolve, reject }); w.postMessage({ id, text }); })) };
      workers.set(dir, h);
      return h;
    }
    async function translate(text, dirs = ['bergamot-enzh']) {
      const hs = dirs.map(get); await Promise.all(hs.map((h) => h.ready)); // loading is not counted in ms
      let out = text, ms = 0;
      for (const h of hs) { const r = await h.call(out); out = r.out; ms += r.ms; }
      return { out, ms };
    }
    return { ready: Promise.all(preload.map((d) => get(d).ready)), translate };
  };
  module.exports.pairDir = pairDir;
  module.exports.chain = chain;
} else {
  const W = path.join(path.dirname(require.resolve('@browsermt/bergamot-translator/package.json')), 'worker');
  const D = workerData;
  const Module = {
    instantiateWasm(info, accept) {
      // no native intgemm outside Firefox: link the wasm_gemm imports to the module's own fallback exports
      const map = {
        int8_prepare_a: 'int8PrepareAFallback', int8_prepare_b: 'int8PrepareBFallback',
        int8_prepare_b_from_transposed: 'int8PrepareBFromTransposedFallback', int8_prepare_b_from_quantized_transposed: 'int8PrepareBFromQuantizedTransposedFallback',
        int8_prepare_bias: 'int8PrepareBiasFallback', int8_multiply_and_add_bias: 'int8MultiplyAndAddBiasFallback', int8_select_columns_of_b: 'int8SelectColumnsOfBFallback',
      };
      let inst;
      const gemm = Object.fromEntries(Object.entries(map).map(([k, n]) => [k, (...a) => inst.exports[n](...a)]));
      WebAssembly.instantiate(fs.readFileSync(path.join(W, 'bergamot-translator-worker.wasm')), { ...info, wasm_gemm: gemm })
        .then((r) => { inst = r.instance; accept(inst); });
      return {};
    },
    print: () => {}, printErr: () => {},
  };
  const ctx = { Module, console, WebAssembly, performance, TextDecoder, TextEncoder, setTimeout, clearTimeout, URL, require, process, __dirname: W, __filename: path.join(W, 'x.js') };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  Module.onRuntimeInitialized = () => {
    const B = Module;
    const files = fs.readdirSync(D), pick = (...pre) => files.find((n) => pre.some((p) => n.startsWith(p)));
    const mem = (file, align) => { const b = fs.readFileSync(path.join(D, file)); const m = new B.AlignedMemory(b.length, align); m.getByteArrayView().set(b); return m; };
    const mf = pick('model.'); // Firefox's rule: *.alphas.bin models carry their own quantization multipliers
    const cfg = ['beam-size: 1', 'normalize: 1.0', 'word-penalty: 0', 'cpu-threads: 0', `gemm-precision: ${mf.includes('alphas') ? 'int8shiftAlphaAll' : 'int8shiftAll'}`,
      'skip-cost: true', 'alignment: soft', 'quiet: true', 'quiet-translation: true', 'max-length-break: 128', 'mini-batch-words: 1024', 'workspace: 128', 'max-length-factor: 2.0'].join('\n');
    const vocabs = new B.AlignedMemoryList();
    vocabs.push_back(mem(pick('srcvocab.', 'vocab.'), 64)); vocabs.push_back(mem(pick('trgvocab.', 'vocab.'), 64)); // most pairs share one vocab
    const model = new B.TranslationModel(cfg, mem(mf, 256), mem(pick('lex.'), 64), vocabs, null);
    const svc = new B.BlockingService({ cacheSize: 0 });
    const tr = (text) => {
      const input = new B.VectorString(); input.push_back(text);
      const opts = new B.VectorResponseOptions(); opts.push_back({ alignment: false, html: false, qualityScores: false });
      const t = performance.now(); const r = svc.translate(model, input, opts); const ms = performance.now() - t;
      const out = r.get(0).getTranslatedText(); input.delete(); opts.delete(); r.delete();
      return { out, ms: Math.round(ms) };
    };
    tr('Hello.'); // warm-up
    parentPort.on('message', ({ id, text }) => {
      try { parentPort.postMessage({ id, ...tr(text) }); } catch (e) { parentPort.postMessage({ id, error: String(e && e.message || e) }); }
    });
    parentPort.postMessage('ready');
  };
  vm.runInContext(fs.readFileSync(path.join(W, 'bergamot-translator-worker.js'), 'utf8'), ctx);
}
