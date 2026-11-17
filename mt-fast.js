// Bergamot (Firefox Translations) en->zh, WASM, in a worker thread so its ~50 ms per call never blocks audio decoding.
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs'), path = require('path'), vm = require('vm');

if (isMainThread) {
  // Returns { ready: Promise, translate(text) -> Promise<{ out, ms }> }
  module.exports = function startFastMt(modelDir) {
    const w = new Worker(__filename, { workerData: modelDir });
    const waiting = new Map(); let next = 0;
    const ready = new Promise((res, rej) => { w.once('message', res); w.once('error', rej); });
    w.on('message', (m) => {
      const p = m && waiting.get(m.id); if (!p) return;
      waiting.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m);
    });
    w.on('error', (e) => { for (const p of waiting.values()) p.reject(e); waiting.clear(); });
    return { ready, translate: (text) => new Promise((resolve, reject) => { const id = ++next; waiting.set(id, { resolve, reject }); w.postMessage({ id, text }); }) };
  };
} else {
  const W = path.join(path.dirname(require.resolve('@browsermt/bergamot-translator/package.json')), 'worker');
  const M = workerData;
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
    const mem = (file, align) => { const b = fs.readFileSync(path.join(M, file)); const m = new B.AlignedMemory(b.length, align); m.getByteArrayView().set(b); return m; };
    const vocabs = new B.AlignedMemoryList(); vocabs.push_back(mem('srcvocab.enzh.spm', 64)); vocabs.push_back(mem('trgvocab.enzh.spm', 64));
    const cfg = ['beam-size: 1', 'normalize: 1.0', 'word-penalty: 0', 'cpu-threads: 0', 'gemm-precision: int8shiftAlphaAll', 'skip-cost: true',
      'alignment: soft', 'quiet: true', 'quiet-translation: true', 'max-length-break: 128', 'mini-batch-words: 1024', 'workspace: 128', 'max-length-factor: 2.0'].join('\n');
    const model = new B.TranslationModel(cfg, mem('model.enzh.intgemm.alphas.bin', 256), mem('lex.50.50.enzh.s2t.bin', 64), vocabs, null);
    const svc = new B.BlockingService({ cacheSize: 0 });
    const tr = (text) => {
      const input = new B.VectorString(); input.push_back(text);
      const opts = new B.VectorResponseOptions(); opts.push_back({ alignment: false, html: false, qualityScores: false });
      const t = performance.now(); const r = svc.translate(model, input, opts); const ms = performance.now() - t;
      const out = r.get(0).getTranslatedText(); input.delete(); opts.delete(); r.delete();
      return { out, ms: Math.round(ms) };
    };
    tr('Hello there.'); // warm-up
    parentPort.on('message', ({ id, text }) => {
      try { parentPort.postMessage({ id, ...tr(text) }); } catch (e) { parentPort.postMessage({ id, error: String(e && e.message || e) }); }
    });
    parentPort.postMessage('ready');
  };
  vm.runInContext(fs.readFileSync(path.join(W, 'bergamot-translator-worker.js'), 'utf8'), ctx);
}
