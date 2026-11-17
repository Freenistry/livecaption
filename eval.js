// Scores the EN->ZH caption pipeline on FLEURS dev (Google, CC-BY-4.0): real English speech + human Chinese reference.
// Usage: node eval.js [n=150] [trail=0.5] [maxlen=10] [mt=http://127.0.0.1:8099] [label=baseline]
//   node eval.js n=30                      quick run (~1 min)
//   node eval.js maxlen=8 label=maxlen8    try a different endpoint setting
//   node eval.js mt=http://127.0.0.1:8199 label=lmt-0.6b   score another llama-server model as the final MT
// Prints one row per approach and appends them to eval-results.jsonl; per-sentence outputs go to data/eval-<label>.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { loadModels, hymt } = require('./live');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const N = +(args.n || 150), TRAIL = +(args.trail || 0.5), MAXLEN = +(args.maxlen || 10);
const MT = args.mt || 'http://127.0.0.1:8099', LABEL = args.label || 'baseline';
const DIR = path.join(__dirname, 'data', 'fleurs');
const RATE = 16000;

// --- metrics -------------------------------------------------------------------------------------------
// chrF (character n-gram F-score, n=1..6, beta=2, whitespace ignored), corpus level, same formula as sacrebleu.
// The standard automatic metric for Chinese MT output, since Chinese has no spaces to split words on.
const ORDER = 6, BETA = 2;
function chrfStats(hyp, ref) {
  const h = [...hyp.replace(/\s+/g, '')], r = [...ref.replace(/\s+/g, '')], st = [];
  const grams = (cs, n) => { const m = new Map(); for (let i = 0; i + n <= cs.length; i++) { const g = cs.slice(i, i + n).join(''); m.set(g, (m.get(g) || 0) + 1); } return m; };
  for (let n = 1; n <= ORDER; n++) {
    const hg = grams(h, n), rg = grams(r, n); let match = 0;
    for (const [g, c] of hg) match += Math.min(c, rg.get(g) || 0);
    st.push([Math.max(0, h.length - n + 1), Math.max(0, r.length - n + 1), match]);
  }
  return st;
}
function chrf(statsList) { // sacrebleu default: average P and R over n-gram orders, then one F-beta
  let ap = 0, ar = 0, eff = 0; const f = BETA * BETA;
  for (let n = 0; n < ORDER; n++) {
    let hc = 0, rc = 0, m = 0; for (const s of statsList) { hc += s[n][0]; rc += s[n][1]; m += s[n][2]; }
    if (hc > 0 && rc > 0) { ap += m / hc; ar += m / rc; eff++; }
  }
  if (!eff) return 0;
  ap /= eff; ar /= eff;
  return ap + ar ? 100 * (1 + f) * ap * ar / (f * ap + ar) : 0;
}
// WER on lowercased words without punctuation, corpus level (total edits / total reference words).
const words = (s) => s.toLowerCase().replace(/-/g, ' ').replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
function edits(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1]));
    prev = cur;
  }
  return prev[b.length];
}

// self-check: sacrebleu 2.5.1 `corpus_chrf` gives 68.55637049547532 on these two pairs
{
  const h = ['今天我们将讨论本季度的结果。', 'Leon Lin 已经成为了 GitHub 上最热门的作家了'], r = ['今天我们将讨论本季度的业绩。', 'Leon Lin 一直是 GitHub 上最热门的作者'];
  const got = chrf(h.map((x, i) => chrfStats(x, r[i])));
  if (Math.abs(got - 68.55637049547532) > 1e-6) throw new Error(`chrF self-check failed: ${got}`);
  if (edits(words('a b c'), words('a x c d')) !== 2) throw new Error('WER self-check failed');
}

// --- data ----------------------------------------------------------------------------------------------
const REV = '70bb2e84b976b7e960aa89f1c648e09c59f894dd'; // pinned dataset revision
const FILES = {
  'en_us-dev.tsv': ['data/en_us/dev.tsv', '9d57ee7e91e9d4c92edb39f6bbea668ef8dc2a3ff96eb510d5580b2ad05d17ec'],
  'cmn_hans_cn-dev.tsv': ['data/cmn_hans_cn/dev.tsv', '6b4efd804b543048feb278db06f3b58b5ea171cdd4ba072e328ad630ca25384b'],
  'dev.tar.gz': ['data/en_us/audio/dev.tar.gz', '2658fda72f199e12676ecac9415094667a4e14e149b146e568ea00b2a2f0954c'], // 171 MB
};
async function ensureData() {
  fs.mkdirSync(DIR, { recursive: true });
  for (const [name, [rel, sha]] of Object.entries(FILES)) {
    const out = path.join(DIR, name);
    if (name === 'dev.tar.gz' && fs.existsSync(path.join(DIR, 'dev'))) continue;
    if (fs.existsSync(out)) continue;
    console.log(`downloading FLEURS ${rel}...`);
    const r = await fetch(`https://huggingface.co/datasets/google/fleurs/resolve/${REV}/${rel}`);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${rel}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (crypto.createHash('sha256').update(buf).digest('hex') !== sha) throw new Error(`sha256 mismatch for ${rel}`);
    fs.writeFileSync(out, buf);
  }
  if (!fs.existsSync(path.join(DIR, 'dev'))) {
    execFileSync(process.platform === 'win32' ? `${process.env.SystemRoot}\\System32\\tar.exe` : 'tar', ['-xzf', 'dev.tar.gz'], { cwd: DIR });
    fs.unlinkSync(path.join(DIR, 'dev.tar.gz'));
  }
  const tsv = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').trim().split('\n').map((l) => l.split('\t'));
  const zh = new Map(tsv('cmn_hans_cn-dev.tsv').map((c) => [c[0], c[2]]));
  const seen = new Set(), items = [];
  for (const c of tsv('en_us-dev.tsv')) { // one recording per sentence id
    if (seen.has(c[0]) || !zh.has(c[0])) continue;
    seen.add(c[0]); items.push({ id: c[0], wav: path.join(DIR, 'dev', c[1]), en: c[2], zh: zh.get(c[0]) });
  }
  return items;
}
function readWav(file) { // 16 kHz mono, PCM16 or float32 (FLEURS ships float32)
  const b = fs.readFileSync(file); let fmt, bits;
  for (let o = 12; o + 8 <= b.length; o += 8 + b.readUInt32LE(o + 4) + (b.readUInt32LE(o + 4) & 1)) {
    const id = b.toString('ascii', o, o + 4), len = b.readUInt32LE(o + 4);
    if (id === 'fmt ') { fmt = b.readUInt16LE(o + 8); bits = b.readUInt16LE(o + 22); if (b.readUInt32LE(o + 12) !== RATE || b.readUInt16LE(o + 10) !== 1) throw new Error(`${file}: need 16 kHz mono`); }
    if (id === 'data') {
      const d = Buffer.from(b.subarray(o + 8, o + 8 + len));
      if (fmt === 3 && bits === 32) return new Float32Array(d.buffer, d.byteOffset, d.length >> 2);
      if (fmt === 1 && bits === 16) return Float32Array.from(new Int16Array(d.buffer, d.byteOffset, d.length >> 1), (v) => v / 32768);
      throw new Error(`${file}: unsupported format ${fmt}/${bits}`);
    }
  }
  throw new Error(`${file}: no data chunk`);
}

// --- pipeline pieces (same models and endpoint rules as /live) ----------------------------------------
function streamSegments(rec, audio) {
  const x = new Float32Array(audio.length + RATE); x.set(audio); // + 1 s silence, as if the speaker stopped
  const s = rec.createStream(), segs = []; let start = 0;
  for (let i = 0; i < x.length; i += 1280) {
    s.acceptWaveform({ sampleRate: RATE, samples: x.subarray(i, i + 1280) });
    while (rec.isReady(s)) rec.decode(s);
    if (rec.isEndpoint(s)) {
      const text = rec.getResult(s).text.trim();
      if (text) segs.push({ text, audio: x.subarray(start, i + 1280) });
      rec.reset(s); start = i + 1280;
    }
  }
  s.inputFinished(); while (rec.isReady(s)) rec.decode(s);
  const text = rec.getResult(s).text.trim();
  if (text) segs.push({ text, audio: x.subarray(start) });
  return segs;
}
const timed = async (fn) => { const t = performance.now(); const out = await fn(); return [out, performance.now() - t]; };

(async () => {
  const items = (await ensureData()).slice(0, N);
  const { rec, off, fast } = loadModels({ trail: TRAIL, maxlen: MAXLEN });
  await fast.ready;
  const asr = async (audio) => { const os = off.createStream(); os.acceptWaveform({ sampleRate: RATE, samples: audio }); await off.decodeAsync(os); return off.getResult(os).text.trim(); };
  await hymt(MT, 'Hello.').catch((e) => { throw new Error(`final MT server at ${MT} is not answering: ${e.message}`); });
  await asr(readWav(items[0].wav)); // warm-up

  // What each approach shows the viewer at the end of a sentence:
  //   fast       grey partial line: streaming ASR text per segment -> Bergamot
  //   final      white line in /live: streaming endpoints cut segments -> Parakeet per segment -> final MT per segment
  //   sentence   same models, but the whole sentence at once (no endpoint cuts): upper bound for `final`
  //   mt:<x>     reference English -> MT only, so ASR errors do not count (pure translation quality)
  const rows = { fast: [], final: [], sentence: [], 'mt:final': [], 'mt:bergamot': [] };
  const detail = [];
  for (const [k, it] of items.entries()) {
    const audio = readWav(it.wav);
    // Peak-normalize to -6 dBFS, like the browser's mic auto-gain. Some FLEURS clips peak at -48 dBFS, and the
    // streaming model returns nothing on those (13/150 sentences), which measures the recording level, not the pipeline.
    let peak = 0; for (const v of audio) peak = Math.max(peak, Math.abs(v));
    if (peak > 0) { const g = 0.5 / peak; for (let i = 0; i < audio.length; i++) audio[i] *= g; }
    const segs = streamSegments(rec, audio);
    const d = { id: it.id, en: it.en, zh: it.zh, segments: segs.length };

    let zh = [], ms = [];
    for (const s of segs) { const r = await fast.translate(s.text); zh.push(r.out); ms.push(r.ms); }
    rows.fast.push({ en: segs.map((s) => s.text).join(' '), zh: zh.join(''), ms }); d.fast = zh.join('');

    zh = []; ms = []; const en = [];
    for (const s of segs) {
      const [e, a] = await timed(() => asr(s.audio)); const [z, b] = await timed(() => hymt(MT, e || s.text));
      en.push(e); zh.push(z); ms.push(a + b);
    }
    rows.final.push({ en: en.join(' '), zh: zh.join(''), ms }); d.final = zh.join('');

    const [e, a] = await timed(() => asr(audio)); const [z, b] = await timed(() => hymt(MT, e));
    rows.sentence.push({ en: e, zh: z, ms: [a + b] }); d.sentence = z; d.asr = e;

    const [z2, c] = await timed(() => hymt(MT, it.en)); rows['mt:final'].push({ zh: z2, ms: [c] }); d.mtFinal = z2;
    const r2 = await fast.translate(it.en); rows['mt:bergamot'].push({ zh: r2.out, ms: [r2.ms] }); d.mtBergamot = r2.out;
    detail.push(d);
    process.stdout.write(`\r${k + 1}/${items.length}`);
  }

  const q = (xs, p) => Math.round([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]);
  const refWords = items.reduce((n, it) => n + words(it.en).length, 0);
  const at = new Date().toISOString(), out = [];
  for (const [name, rs] of Object.entries(rows)) {
    const ms = rs.flatMap((r) => r.ms);
    out.push({
      at, label: LABEL, approach: name, n: items.length, trail: TRAIL, maxlen: MAXLEN, mt: MT,
      chrF: +chrf(rs.map((r, i) => chrfStats(r.zh, items[i].zh))).toFixed(1),
      wer: rs[0].en === undefined ? null : +(100 * rs.reduce((s, r, i) => s + edits(words(items[i].en), words(r.en)), 0) / refWords).toFixed(1),
      msP50: q(ms, 0.5), msP90: q(ms, 0.9),
      segsPerSentence: name === 'fast' || name === 'final' ? +(detail.reduce((s, d) => s + d.segments, 0) / detail.length).toFixed(2) : 1,
    });
  }
  console.log(`\n\nFLEURS dev, ${items.length} sentences, trail=${TRAIL}s maxlen=${MAXLEN}s, final MT ${MT} (${LABEL})\n`);
  console.log('approach      chrF   WER%   ms p50   ms p90   segs/sentence');
  for (const r of out) console.log(`${r.approach.padEnd(12)} ${String(r.chrF).padStart(5)}  ${String(r.wer ?? '-').padStart(5)}  ${String(r.msP50).padStart(7)}  ${String(r.msP90).padStart(7)}   ${r.segsPerSentence}`);
  fs.appendFileSync(path.join(__dirname, 'eval-results.jsonl'), out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(__dirname, 'data', `eval-${LABEL}.json`), JSON.stringify(detail, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
