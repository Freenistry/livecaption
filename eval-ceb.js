// Text only (no ASR): Cebuano, Filipino and Cebuano-English mixed sentences -> English, chrF vs the reference English.
// Bergamot has no Cebuano model, so this tests its Tagalog->English model on Cebuano, against Hy-MT2.
// Usage: node get-models.js --to=en tl  then  node eval-ceb.js   (Hy-MT2 on :8099)
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { hymt } = require('./live');
const { ensureData, chrf, chrfStats, REV, DIR } = require('./eval');
const MT = 'http://127.0.0.1:8099';
const SHA = { ceb_ph: '22e98fd67069aa88a61cd2115d576d2fd090ebe576fa421f351bfcec0ebe23ab', fil_ph: 'c91a86fbc6b62fb914787afb017a827efdea66931e2bc40489bca9257c1f5846' };

// Code-switched sentences with the intended English. Written by the assistant, not a native speaker:
// a smoke test, not a benchmark. FLEURS has no code-switched speech or text.
const MIX = [
  ['Ang meeting nato ugma kay i-move sa Friday kay busy ang boss.', 'Our meeting tomorrow will be moved to Friday because the boss is busy.'],
  ['Pwede ba nimo i-send ang report before lunch?', 'Can you send the report before lunch?'],
  ['Na-late ko kay grabe ang traffic sa highway ganina.', 'I was late because the traffic on the highway was terrible earlier.'],
  ['Wala pa ko ka-check sa email, pero I will reply later.', "I haven't checked the email yet, but I will reply later."],
  ['Ang presyo sa gasolina nag-increase na pud this week.', 'The price of gasoline increased again this week.'],
  ['Kinsa ang in charge sa project ug kanus-a ang deadline?', 'Who is in charge of the project and when is the deadline?'],
  ['I-update lang nako ang system then i-restart nato ang server.', "I'll just update the system, then we'll restart the server."],
  ['Lami kaayo ang food didto pero medyo mahal.', 'The food there is really delicious but a bit expensive.'],
  ['Basin mag-ulan mamaya so dad-a imong payong.', 'It might rain later so bring your umbrella.'],
  ['Nag-training mi sa new software pero lisod pa siya gamiton.', "We trained on the new software but it's still hard to use."],
  ['Ayaw kalimti nga naa tay presentation sa client sa Monday.', "Don't forget that we have a presentation to the client on Monday."],
  ['Gi-cancel nila ang flight tungod sa bagyo.', 'They cancelled the flight because of the typhoon.'],
];

async function tsv(name) { // FLEURS transcripts, id -> sentence; downloaded once, sha256-checked
  const f = path.join(DIR, `${name}-dev.tsv`);
  if (!fs.existsSync(f)) {
    const r = await fetch(`https://huggingface.co/datasets/google/fleurs/resolve/${REV}/data/${name}/dev.tsv`);
    const b = Buffer.from(await r.arrayBuffer());
    if (!r.ok || crypto.createHash('sha256').update(b).digest('hex') !== SHA[name]) throw new Error(`bad download: ${name}`);
    fs.writeFileSync(f, b);
  }
  return new Map(fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => l.split('\t')).map((c) => [c[0], c[2]]));
}
const q = (xs, p) => Math.round([...xs].sort((a, b) => a - b)[Math.floor(xs.length * p)]);

(async () => {
  const en = new Map((await ensureData()).map((it) => [it.id, it.en]));
  const fast = require('./mt-fast')(path.join(__dirname, 'models'), ['bergamot-tlen']);
  await fast.ready;
  await hymt(MT, 'Hello.', 'English').catch((e) => { throw new Error(`Hy-MT2 at ${MT} is not answering: ${e.message}`); });
  const out = {};
  async function run(name, pairs) {
    const S = { b: [], h: [] }, ms = { b: [], h: [] }, d = [];
    for (const [src, ref] of pairs) {
      const b = await fast.translate(src, ['bergamot-tlen']);
      const t = performance.now(); const h = await hymt(MT, src, 'English'); ms.h.push(performance.now() - t); ms.b.push(b.ms);
      S.b.push(chrfStats(b.out, ref)); S.h.push(chrfStats(h, ref)); d.push({ src, ref, bergamot: b.out, hymt: h });
    }
    out[name] = d;
    console.log(`${name.padEnd(20)} n=${String(pairs.length).padStart(3)}   Bergamot tl->en chrF ${chrf(S.b).toFixed(1).padStart(5)} (${q(ms.b, 0.5)}/${q(ms.b, 0.9)} ms)   Hy-MT2 chrF ${chrf(S.h).toFixed(1).padStart(5)} (${q(ms.h, 0.5)}/${q(ms.h, 0.9)} ms)`);
  }
  const ceb = await tsv('ceb_ph'), fil = await tsv('fil_ph');
  const ids = [...ceb.keys()].filter((i) => en.has(i));
  await run('Cebuano (FLEURS)', ids.map((i) => [ceb.get(i), en.get(i)]));
  await run('Filipino (FLEURS)', ids.filter((i) => fil.has(i)).map((i) => [fil.get(i), en.get(i)]));
  await run('Cebuano-English mix', MIX);
  fs.writeFileSync(path.join(__dirname, 'data', 'eval-ceb.json'), JSON.stringify(out, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
