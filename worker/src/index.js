// livecaption Worker: serves ../public (static assets) and POST /api/segment (WAV -> {src, dst, asrMs, mtMs, totalMs}).
const MAX_WAV = 1 << 20; // 1 MiB ≈ 32 s of 16 kHz PCM16; client caps segments at 8 s

const json = (o, status = 200) => Response.json(o, { status });

function b64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

// constant-time-ish compare; tokens are short so length leak is acceptable
function same(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function viaLocal(wav, env) {
  if (!env.LOCAL_BACKEND_URL) throw new Error('LOCAL_BACKEND_URL not set');
  const r = await fetch(`${env.LOCAL_BACKEND_URL.replace(/\/$/, '')}/api/segment`, {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav,
  });
  const j = await r.json().catch(() => ({ error: `local backend HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error || `local backend HTTP ${r.status}`);
  return j;
}

// Schemas checked 2026-11-16: whisper-large-v3-turbo takes audio as base64 string, returns {text, transcription_info:{language}};
// m2m100-1.2b takes {text, source_lang, target_lang} (ISO codes, e.g. 'en','de'), returns {translated_text}.
async function viaWorkersAi(wav, env) {
  const t0 = Date.now();
  const a = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio: b64(wav), task: 'transcribe' });
  const src = (a.text || '').replace(/\s+/g, ' ').trim();
  const asrMs = Date.now() - t0;
  if (!src) return { src, dst: '', asrMs, mtMs: 0, totalMs: asrMs };
  const b = Date.now();
  const m = await env.AI.run('@cf/meta/m2m100-1.2b', {
    text: src, source_lang: a.transcription_info?.language || 'en', target_lang: env.TARGET_LANG || 'de',
  });
  return { src, dst: (m.translated_text || '').trim(), asrMs, mtMs: Date.now() - b, totalMs: Date.now() - t0 };
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (pathname === '/api/health') {
      return json({ backend: env.BACKEND, target: env.TARGET_LANG, ok: env.BACKEND === 'workersai' ? !!env.AI : !!env.LOCAL_BACKEND_URL });
    }
    if (pathname === '/api/segment/stream') {
      if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      if (!same(req.headers.get('x-app-token'), env.APP_TOKEN)) return json({ error: 'unauthorized' }, 401);
      const wav = await req.arrayBuffer();
      if (wav.byteLength > MAX_WAV) return json({ error: 'too large' }, 413);
      const sse = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' };
      if (env.BACKEND === 'local') {
        const r = await fetch(`${env.LOCAL_BACKEND_URL.replace(/\/$/, '')}/api/segment/stream`, {
          method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav,
        });
        if (!r.ok || !r.body) return json({ error: `local backend HTTP ${r.status}` }, 502);
        return new Response(r.body, { status: 200, headers: sse });
      }
      // Workers AI here has no token streaming, so the whole line is emitted as one delta.
      // That is honest: the page shows it arriving at once rather than pretending to type it.
      const j = await viaWorkersAi(wav, env);
      const body =
        `data: ${JSON.stringify({ type: 'src', src: j.src, asrMs: j.asrMs })}\n\n` +
        (j.dst ? `data: ${JSON.stringify({ type: 'delta', d: j.dst })}\n\n` : '') +
        `data: ${JSON.stringify({ type: 'done', ...j, audioMs: 0 })}\n\n`;
      return new Response(body, { headers: sse });
    }
    if (pathname === '/api/segment') {
      if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      if (!same(req.headers.get('x-app-token'), env.APP_TOKEN)) return json({ error: 'unauthorized' }, 401);
      if (+req.headers.get('content-length') > MAX_WAV) return json({ error: 'too large' }, 413);
      const wav = await req.arrayBuffer();
      if (wav.byteLength > MAX_WAV) return json({ error: 'too large' }, 413);
      if (wav.byteLength < 46 || new TextDecoder().decode(new Uint8Array(wav, 0, 4)) !== 'RIFF') return json({ error: 'expected WAV' }, 400);
      try {
        if (env.BACKEND === 'local') return json(await viaLocal(wav, env));
        if (env.BACKEND === 'workersai') return json(await viaWorkersAi(wav, env));
        return json({ error: `unknown BACKEND '${env.BACKEND}'` }, 500);
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
