// Downloads the Bergamot models /live needs for the given source languages (+ en -> target), sha256-checked
// against Mozilla's own records (the same list Firefox reads). Skips files already present and correct.
// Usage: node get-models.js es de ja         (target defaults to zh-Hans)
//        node get-models.js --to=ja es de
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { pairDir, chain } = require('./mt-fast');

const RECORDS = 'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records';
const CDN = 'https://firefox-settings-attachments.cdn.mozilla.net/';
const args = process.argv.slice(2);
const to = (args.find((a) => a.startsWith('--to=')) || '--to=zh-Hans').slice(5);
const srcs = args.filter((a) => !a.startsWith('--')).flatMap((a) => a.split(',')).filter(Boolean); // PowerShell passes -Langs es,ja as one "es,ja"
// a stalled CDN download hung a Docker build for 15 min: give up after 2 min and retry (3 tries)
async function get(url) {
  for (let i = 1; ; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); }
    catch (e) { if (i === 3) throw new Error(`${url}: ${e.message}`); console.log(`retry ${i}: ${e.message}`); }
  }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// numeric version compare, stable releases only ("2.1" > "2.0", "2.0a2" skipped)
const ver = (v) => (/^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null);
const newer = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); return false; };

(async () => {
  if (!srcs.length) throw new Error('usage: node get-models.js [--to=zh-Hans] <src lang> ...');
  const recs = JSON.parse(await get(RECORDS)).data.filter((r) => !/OS == 'Android'/.test(r.filter_expression || '')); // drop Android-only builds
  const pairs = new Set(srcs.flatMap((s) => [[s, 'en'], ['en', to]]).filter(([a, b]) => a !== b).map((p) => p.join('>')));
  for (const p of pairs) {
    const [from, toL] = p.split('>');
    const rs = recs.filter((r) => r.fromLang === from && r.toLang === toL && ver(r.version));
    if (!rs.length) { console.log(`${from} -> ${toL}: no Bergamot model (Firefox does not ship it)`); continue; }
    const best = rs.reduce((a, r) => (newer(ver(r.version), ver(a.version)) ? r : a)).version;
    const dir = path.join(__dirname, 'models', pairDir(from, toL));
    fs.mkdirSync(dir, { recursive: true });
    for (const r of rs.filter((x) => x.version === best)) {
      const out = path.join(dir, r.name);
      if (fs.existsSync(out) && sha(fs.readFileSync(out)) === r.attachment.hash) continue;
      const buf = await get(CDN + r.attachment.location);
      if (sha(buf) !== r.attachment.hash) throw new Error(`sha256 mismatch for ${r.name}`);
      fs.writeFileSync(out, buf);
    }
    console.log(`${from} -> ${toL}: v${best} in models/${pairDir(from, toL)}`);
  }
  for (const s of srcs) console.log(`${s} -> ${to}: ${chain(s, to).join(' + ')}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
