// Parity check: browser VAD (public/vad.js) vs server VAD (server.js) on data/test.pcm. Run: node vad.test.js [file.pcm]
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { createVad, toWav } = require('./public/vad.js');

// pull createVad out of server.js without starting the server
const src = fs.readFileSync(__dirname + '/server.js', 'utf8');
const ctx = { RATE: 16000, FRAME: 320 };
vm.runInNewContext(src.slice(src.indexOf('// --- VAD'), src.indexOf('// --- ASR')) + ';this.createVad = createVad;', ctx);

const buf = fs.readFileSync(process.argv[2] || __dirname + '/data/test.pcm');
const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);

function run(make) {
  const segs = [];
  const v = make((s) => segs.push(s));
  for (let i = 0; i < pcm.length; i += 1600) v.push(pcm.subarray(i, i + 1600)); // 100 ms chunks, like the worklet
  v.flush();
  return segs;
}
const a = run(ctx.createVad), b = run(createVad);
const ms = (s) => s.map((x) => x.length / 16);
console.log('server segments (ms):', ms(a), ' client segments (ms):', ms(b));
assert.strictEqual(b.length, 2);
assert.deepStrictEqual(ms(b), ms(a));
b.forEach((s, i) => assert.ok(Buffer.from(s.buffer).equals(Buffer.from(a[i].buffer)), `segment ${i} samples differ`));

const w = new Uint8Array(toWav(b[0]));
assert.strictEqual(w.length, 44 + b[0].length * 2);
assert.strictEqual(Buffer.from(w.subarray(0, 4)).toString(), 'RIFF');
console.log('ok');
