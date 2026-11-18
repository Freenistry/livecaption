// Scores English speech -> 15 target languages on FLEURS dev (same sentences, human reference per language).
// Same English models and endpoint rules as /live and eval.js; only the translation step changes per target.
// Usage: node eval-targets.js [n=150] [mt=http://127.0.0.1:8099] [only=hi,ja]
// Needs: node get-models.js --to=<x> en  for each target (Bergamot en->x), Hy-MT2 on llama-server at mt.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { loadModels, hymt } = require('./live');
const { ensureData, readWav, streamSegments, chrf, chrfStats, REV, DIR } = require('./eval');
const { pairDir } = require('./mt-fast');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const N = +(args.n || 150), MT = args.mt || 'http://127.0.0.1:8099', RATE = 16000;
// Most spoken languages after English (Ethnologue 2025, total speakers) that both Bergamot and Hy-MT2 cover.
// [code, Hy-MT2 prompt name, FLEURS config, sha256 of its dev.tsv at REV]
const TARGETS = [
  ['zh-Hans', 'Simplified Chinese', 'cmn_hans_cn', '6b4efd804b543048feb278db06f3b58b5ea171cdd4ba072e328ad630ca25384b'],
  ['hi', 'Hindi', 'hi_in', 'cea87c57a37a0d38ed0afce30e68a35ad7b3945414648430fee09a54ca7b72ba'],
  ['es', 'Spanish', 'es_419', '352b2a5f03f02fe752254fab737f76519963650f4630d2fb63957177aeec927f'],
  ['ar', 'Arabic', 'ar_eg', '3c9ea61dfd884a47e03ee33c4ef601bed0a1142ce7e5b279cccd0cf321792913'],
  ['fr', 'French', 'fr_fr', '3e0b792358c1cb4a426fe1c18fc1571d5406b390d738a2ed1bfd3c8b9d28de44'],
  ['bn', 'Bengali', 'bn_in', '239a59e4d60a76d4d388d44f72df6d28b91e4526d829186d15ef33fde7a089db'],
  ['pt', 'Portuguese', 'pt_br', '69a60f2ef2964da22ac38c3fe223a5ff5d59b9d7fb8ccfcc7003737fc7a1f69c'],
  ['ru', 'Russian', 'ru_ru', '25d9dc88a7533fc0f303354a8e6d3c8186c557229c9a0024487090a11226171e'],
  ['id', 'Indonesian', 'id_id', '8377bf6d8738491b7b0672de47e42123ce07b069a0db920ab6300e3ecce02c18'],
  ['ur', 'Urdu', 'ur_pk', '80fe94d485d78e6277af6ca308c5ceb40f9a19352907cfada9ed07006ac20eed'],
  ['de', 'German', 'de_de', '055b6ddecc9ad493d9ead86babe3ebe225148dd3c174fa6f95cb83a4f9586e18'],
  ['ja', 'Japanese', 'ja_jp', '92beded0999347ad5b8599fe70940e2e7b9232c67c426defb258e596ade94f48'],
  ['mr', 'Marathi', 'mr_in', 'aa8219008c8a14584acb7b7e3cd20c1c32b55c3fb96f45d6e901e8eacbe43c9c'],
  ['vi', 'Vietnamese', 'vi_vn', 'c9bc17cede9765b1c75cb7a608f7066cb6bb6f8245cc75d721a5217a5dffb414'],
  ['te', 'Telugu', 'te_in', 'fbedc2a5b7e394ff5a6e8c269f616017d2ac9a247ffa707c10efaa08132a0630'],
];

async function refs(fleurs, sha) { // id -> human translation
  const f = path.join(DIR, `${fleurs}-dev.tsv`);
  if (!fs.existsSync(f)) {
    const r = await fetch(`https://huggingface.co/datasets/google/fleurs/resolve/${REV}/data/${fleurs}/dev.tsv`);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${fleurs}`);
    const b = Buffer.from(await r.arrayBuffer());
    if (crypto.createHash('sha256').update(b).digest('hex') !== sha) throw new Error(`sha256 mismatch for ${fleurs}`);
    fs.writeFileSync(f, b);
  }
  return new Map(fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => l.split('\t')).map((c) => [c[0], c[2]]));
}
const q = (xs, p) => Math.round([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]);
const timed = async (fn) => { const t = performance.now(); const out = await fn(); return [out, performance.now() - t]; };

(async () => {
  const items = (await ensureData()).slice(0, N);
  const only = args.only ? args.only.split(',') : null;
  const targets = TARGETS.filter(([c]) => !only || only.includes(c));
  for (const [c] of targets) if (!fs.existsSync(path.join(__dirname, 'models', pairDir('en', c)))) throw new Error(`missing models/${pairDir('en', c)} (node get-models.js --to=${c} en)`);
  await hymt(MT, 'Hello.').catch((e) => { throw new Error(`Hy-MT2 at ${MT} is not answering: ${e.message}`); });

  // 1) English speech once: streaming segments (grey source) and Parakeet per segment (white source). Cached.
  const cache = path.join(__dirname, 'data', `eval-targets-asr-${N}.json`);
  let asr = fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, 'utf8')) : null;
  const { rec, off, fast } = loadModels();
  await fast.ready;
  if (!asr) {
    asr = [];
    for (const [k, it] of items.entries()) {
      const audio = readWav(it.wav);
      let peak = 0; for (const v of audio) peak = Math.max(peak, Math.abs(v)); // -6 dBFS, as in eval.js
      if (peak > 0) { const g = 0.5 / peak; for (let i = 0; i < audio.length; i++) audio[i] *= g; }
      const segs = streamSegments(rec, audio).map((s) => {
        const os = off.createStream(); os.acceptWaveform({ sampleRate: RATE, samples: s.audio }); off.decode(os);
        return { grey: s.text, white: off.getResult(os).text.trim() || s.text };
      });
      asr.push({ id: it.id, en: it.en, segs });
      process.stdout.write(`\rasr ${k + 1}/${items.length}`);
    }
    fs.writeFileSync(cache, JSON.stringify(asr));
  }

  // 2) Per target: grey = Bergamot en->x on streaming text, white = Hy-MT2 on Parakeet text,
  //    mt:* = the same translators on the reference English (translation quality alone, no speech errors).
  const out = [], at = new Date().toISOString(), detail = {};
  for (const [code, name, fleurs, sha] of targets) {
    const ref = await refs(fleurs, sha), dirs = [pairDir('en', code)];
    const S = { grey: [], white: [], 'mt:bergamot': [], 'mt:hymt': [] }, ms = { grey: [], white: [] }; detail[code] = [];
    const rs = asr.filter((a) => ref.has(a.id));
    for (const [k, a] of rs.entries()) {
      const grey = [], white = [];
      for (const s of a.segs) {
        const g = await fast.translate(s.grey, dirs); grey.push(g.out); ms.grey.push(g.ms);
        const [w, t] = await timed(() => hymt(MT, s.white, name)); white.push(w); ms.white.push(t);
      }
      const mb = (await fast.translate(a.en, dirs)).out, mh = await hymt(MT, a.en, name), r = ref.get(a.id);
      S.grey.push(chrfStats(grey.join(' '), r)); S.white.push(chrfStats(white.join(' '), r));
      S['mt:bergamot'].push(chrfStats(mb, r)); S['mt:hymt'].push(chrfStats(mh, r));
      detail[code].push({ id: a.id, en: a.en, ref: r, grey: grey.join(' '), white: white.join(' '), mtBergamot: mb, mtHymt: mh });
      process.stdout.write(`\r${code} ${k + 1}/${rs.length}   `);
    }
    const row = { at, label: 'targets', target: code, n: rs.length, mt: MT, ...Object.fromEntries(Object.entries(S).map(([k, v]) => [k, +chrf(v).toFixed(1)])),
      greyMsP50: q(ms.grey, 0.5), greyMsP90: q(ms.grey, 0.9), whiteMsP50: q(ms.white, 0.5), whiteMsP90: q(ms.white, 0.9) };
    out.push(row);
    fs.appendFileSync(path.join(__dirname, 'eval-results.jsonl'), JSON.stringify(row) + '\n');
    fs.writeFileSync(path.join(__dirname, 'data', 'eval-targets.json'), JSON.stringify(detail, null, 1));
  }

  console.log(`\n\nEnglish speech (FLEURS dev) -> target, chrF vs human reference; ms = translation time per segment\n`);
  console.log('target    n   grey  white  mt:bergamot  mt:hymt   grey ms p50/p90   white ms p50/p90');
  for (const r of out) console.log(`${r.target.padEnd(8)}${String(r.n).padStart(4)}  ${String(r.grey).padStart(5)}  ${String(r.white).padStart(5)}  ${String(r['mt:bergamot']).padStart(11)}  ${String(r['mt:hymt']).padStart(7)}   ${`${r.greyMsP50}/${r.greyMsP90}`.padStart(15)}   ${`${r.whiteMsP50}/${r.whiteMsP90}`.padStart(16)}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
