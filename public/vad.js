// Energy VAD, ported 1:1 from server.js createVad (browser + Node). Input: Int16Array PCM16 16 kHz mono chunks.
(function (root) {
  const FRAME = 320;             // 20 ms @ 16 kHz
  const END_SIL_FRAMES = 35;    // 700 ms
  const MAX_FRAMES = 400;       // 8 s
  const MIN_SPEECH_FRAMES = 20; // 400 ms
  const PREROLL_FRAMES = 10;    // 200 ms kept before onset
  const ABS_FLOOR_DB = -45;     // threshold never below this (dBFS)

  function frameDb(pcm, off) {
    let s = 0;
    for (let i = off; i < off + FRAME; i++) { const v = pcm[i] / 32768; s += v * v; }
    return 10 * Math.log10(s / FRAME + 1e-10);
  }

  // calls onSegment(Int16Array) for each completed utterance
  function createVad(onSegment) {
    let rest = new Int16Array(0);
    let noise = -60, frames = [], pre = [], silent = 0, speaking = false;

    function close() {
      if (frames.length - silent >= MIN_SPEECH_FRAMES) {
        const out = new Int16Array(frames.length * FRAME);
        frames.forEach((f, i) => out.set(f, i * FRAME));
        onSegment(out);
      }
      frames = []; silent = 0; speaking = false;
    }

    return {
      push(chunk) {
        const pcm = new Int16Array(rest.length + chunk.length);
        pcm.set(rest); pcm.set(chunk, rest.length);
        let off = 0;
        for (; off + FRAME <= pcm.length; off += FRAME) {
          const f = pcm.slice(off, off + FRAME);
          const db = frameDb(pcm, off);
          const isSpeech = db > Math.max(noise + 6, ABS_FLOOR_DB);
          if (!speaking) {
            noise = db < noise ? db : noise * 0.98 + db * 0.02; // adaptive floor: drop fast, rise slowly
            pre.push(f); if (pre.length > PREROLL_FRAMES) pre.shift();
            if (isSpeech) { speaking = true; frames = pre; pre = []; silent = 0; }
            continue;
          }
          frames.push(f);
          silent = isSpeech ? 0 : silent + 1;
          if (silent >= END_SIL_FRAMES || frames.length >= MAX_FRAMES) close();
        }
        rest = pcm.slice(off);
      },
      flush() { if (speaking) close(); },
    };
  }

  // 44-byte PCM16 mono 16 kHz WAV
  function toWav(pcm) {
    const n = pcm.length * 2, b = new ArrayBuffer(44 + n), v = new DataView(b);
    const str = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n, true);
    new Int16Array(b, 44).set(pcm);
    return b;
  }

  root.Vad = { createVad, toWav };
  if (typeof module !== 'undefined') module.exports = root.Vad;
})(typeof window !== 'undefined' ? window : globalThis);
