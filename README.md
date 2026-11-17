# livecaption

Live translated captions POC: mic → 16 kHz PCM16 → energy VAD (in the browser) → WAV per utterance → `POST /api/segment` → whisper.cpp (CPU) → Hy-MT2 1.8B via llama.cpp (Vulkan) → captions in the browser.

Node + one dependency (`ws`). No build step.

## Run (Windows)

```powershell
.\setup.ps1   # downloads whisper.cpp b5454 + ggml-base.bin if missing, npm install, checks ..\bench
.\start.ps1   # whisper-server :8081, llama-server :8099, node :3000; Ctrl+C stops all
.\start.ps1 -SourceLang es -TargetLang "Simplified Chinese"   # fixed pair; keeps whisper from spending an extra pass on language detection
```

Open http://localhost:3000 and click **Start mic**.

`setup.ps1` / `start.ps1` expect `llama-server.exe` and `Hy-MT2-Q4.gguf` in `..\bench`. Set `VENDOR_BENCH_DIR` to point elsewhere.

Env (server.js): `PORT=3000`, `ASR_URL=http://127.0.0.1:8081`, `MT_URL=http://127.0.0.1:8099`, `TARGET_LANG=German`, `SOURCE_LANG=auto`.

## Live two-stage captions, English → Chinese (`/live`)

Open http://localhost:3000/live.html. The page streams 80 ms PCM frames over a WebSocket and gets two kinds of captions:

| | Fast partial (grey) | Final (replaces it) |
|---|---|---|
| ASR | NeMo streaming FastConformer CTC 80 ms, int8, CPU 2 threads (sherpa-onnx) | Parakeet TDT-CTC 110M int8, CPU, on the whole segment |
| MT | Bergamot en→zh-Hans 2.2 (Firefox's model), WASM in a worker thread | Hy-MT2 via llama-server :8099 (falls back to Bergamot if it is down) |
| When | every time the English partial changes | after a 0.5 s pause, or every 5 s of continuous speech |

Measured with `node live.test.js <clip.wav> ws://127.0.0.1:3000/live` on the first 30 s of a YouTube talk (one English speaker), warm, light background load:

| | p50 | p90 / max |
|---|---|---|
| Chinese partial: Bergamot time per update | 31 ms | 58 ms |
| Chinese partial: English change → Chinese sent | 32 ms | 59 ms |
| Final: pause detected → Chinese final sent | 553 ms | 755 ms max |
| Final: Parakeet / Hy-MT2 | 190 ms / 390 ms | |

The English partial itself is ~1 ms of work per 80 ms chunk (45 ms worst). A word still shows up about 0.35–0.45 s after it is spoken, because the streaming model has to hear past it; no model tested gets that under ~0.3 s.

Partials only show the prefix two consecutive translations agree on and do not shrink when the newest is shorter. On the lab recording that cut visible retractions from 103 to 21 in 30 s.

Everything on the fast path is CPU. When another program saturated the CPU (a Rust build), finals slipped to 2–10 s. Keep the box otherwise idle.

`setup.ps1` downloads the three models (~300 MB, every file sha256-pinned). The Parakeet tarball needs Git for Windows' `tar` + `bzip2`: Windows' own `tar.exe` hangs on it.

## Scoring models and approaches (`eval.js`)

```powershell
node eval.js                                   # 150 sentences, ~6 min; needs Hy-MT2 on :8099
node eval.js n=30                              # quick check
node eval.js maxlen=8 label=maxlen8            # different endpoint setting
node eval.js mt=http://127.0.0.1:8199 label=x  # another llama-server model as the final MT
```

Test set: **FLEURS dev** (Google, CC-BY-4.0). 150 English sentences read aloud by real people, each with a human Chinese translation of the same sentence. The first run downloads 171 MB (pinned revision, sha256-checked).

Every run prints one row per approach and appends them to `eval-results.jsonl`, so runs can be compared over time. Per-sentence outputs go to `data/eval-<label>.json`, for reading what the models actually said.

| approach | what it is |
|---|---|
| `fast` | The grey partial: streaming ASR text per segment → Bergamot |
| `final` | The white line in `/live`: segments cut by the endpointer → Parakeet → final MT |
| `sentence` | Same models on the whole sentence, no cuts. The best `final` could get with perfect segmentation |
| `mt:final`, `mt:bergamot` | The human English text → MT only. Pure translation quality, no speech errors |

| column | meaning | better |
|---|---|---|
| `chrF` | Character n-gram overlap with the human Chinese, 0–100 (sacrebleu's formula; the self-check matches it to 1e-6) | higher |
| `WER%` | English words wrong vs. what was said | lower |
| `ms p50/p90` | Compute per segment (fast: MT only; final: ASR + MT) | lower |
| `segs/sentence` | How many pieces the endpointer cut each sentence into | — |

How to read it:
- **Compare rows, not absolute numbers.** chrF of 30 vs. 33 on Chinese is a real gap; ±1 is noise at 150 sentences.
- `sentence` minus `final` is what segmentation costs you. `mt:final` minus `sentence` is what ASR errors cost you.
- chrF penalizes a correct paraphrase that uses different characters. Read `data/eval-<label>.json` before trusting a small win. COMET (neural, closer to human judgment) is the next step up, but it needs a ~2 GB model.
- Only this one test set: read speech, one sentence per clip, no names from the YouTube clip.

## Test without a mic

```powershell
# raw PCM16, 16 kHz, mono, no header
curl.exe -X POST --data-binary "@data\test.pcm" http://localhost:3000/selftest
```

This runs the server-side VAD → ASR → MT path (same VAD as the browser and the legacy `/ws` route).

```powershell
# one segment, WAV in (what the browser sends)
curl.exe -X POST -H "content-type: audio/wav" --data-binary "@dataone.wav" http://localhost:3000/api/segment
node vad.test.js   # browser VAD (public/vad.js) == server VAD on data	est.pcm: 2 segments, identical samples
```

Node checks `x-app-token` on `/api/segment` and `/selftest`, and `?token=` on `/ws` and `/live`, whenever `APP_TOKEN` is set. Set it before exposing the box through a tunnel; unset, those routes are open.

## Measured (GTX 1060 6GB, i7-7700K, whisper base on 4 CPU threads, `-ac 512`)

Input: System.Speech TTS, "Hello, welcome to the meeting. Today we will discuss the quarterly results." (6.0 s). The VAD splits it into 2 segments. Numbers are from warm runs; the first request after boot adds about 0.5 s to ASR and MT.

| segment | ASR text | German | asrMs | mtMs | totalMs |
|---|---|---|---|---|---|
| 2.6 s | Hello, welcome to the meeting. | Hallo, willkommen zur Besprechung. | 539 | 150 | 689 |
| 3.3 s | Today we will discuss the quarterly results. | Heute werden wir über die Quartalsergebnisse sprechen. | 561 | 199 | 760 |

`totalMs` is measured from VAD end-of-segment. Perceived delay from end of speech is about totalMs + 700 ms (the end-of-speech silence window).

`-ac 512` caps whisper's encoder window at about 10 s, which covers the 8 s VAD cap. It cut ASR from about 1.7 s to 0.55 s per segment.

## Limits

- One segment in flight per connection, with a 1-slot backlog. Older unprocessed segments are dropped instead of lagging behind.
- Built for one user; multiple connections share the same backends serially.
- Energy VAD only: noisy rooms need threshold tuning (`ABS_FLOOR_DB`, +6 dB over the noise floor). No diarization, no partial/streaming hypotheses.
- ASR runs on the CPU. `-l auto` costs an extra encoder pass; set `SOURCE_LANG` plus whisper `-l` to save about 40%.

## Cloudflare Worker (`worker/`)

The browser does VAD and sends one WAV per utterance to `POST /api/segment` (header `x-app-token`). The Worker serves `public/` as static assets (same file as Node, not copied) and runs ASR + MT. It holds no state.

| | Hybrid (`BACKEND=local`) | Full Cloudflare (`BACKEND=workersai`) |
|---|---|---|
| UI + auth | Worker | Worker |
| ASR | whisper.cpp base on your PC, via Cloudflare Tunnel | `@cf/openai/whisper-large-v3-turbo` |
| MT | Hy-MT2 1.8B on your PC (`TARGET_LANG` set in Node) | `@cf/meta/m2m100-1.2b` (`TARGET_LANG` = ISO code, e.g. `de`) |
| PC must be on | yes | no |
| Cost | Workers free tier | Workers AI neurons (free daily allowance, then paid) |
| Status | **tested locally** (below) | **untested**: needs a Cloudflare account |

Endpoints: `GET /api/health` → `{backend, target, ok}`; `POST /api/segment` (WAV, ≤1 MiB) → `{src, dst, asrMs, mtMs, totalMs}`, 401 without a valid token.

### Deploy

```powershell
cd worker
npm install
npm run check                       # wrangler deploy --dry-run, no login needed
npx wrangler login
npx wrangler secret put APP_TOKEN   # pick a long random string
# edit wrangler.toml [vars]: BACKEND, TARGET_LANG, LOCAL_BACKEND_URL
npm run deploy
```

Open `https://livecaption.<you>.workers.dev/?token=<APP_TOKEN>` once; the page keeps the token in localStorage.

### Hybrid: tunnel to your PC

```powershell
.start.ps1                                         # Node :3000 + backends
cloudflared tunnel --url http://localhost:3000      # prints https://<random>.trycloudflare.com
```

Put that URL in `LOCAL_BACKEND_URL` and redeploy. Quick tunnels get a new URL on every start; use a named tunnel for a stable one. Set `APP_TOKEN` before starting Node so `/api/segment`, `/selftest` and `/ws` all require `x-app-token` — otherwise anyone who finds the URL can burn your GPU. Many home routers' DNS filters also block `*.trycloudflare.com`, so a named tunnel on your own domain is the practical choice.

### Local dev

```powershell
# worker.dev.vars (gitignored):  APP_TOKEN=devtoken123
cd worker; npm run dev:local   # http://localhost:8787, proxies to Node on :3000
```

`npm run dev` (default env) needs `wrangler login`: the `[ai]` binding always runs remotely, even with `BACKEND=local`. `dev:local` uses `[env.local]`, which leaves out the AI binding.

Measured through `wrangler dev --env local` → Node → local backends (same machine as above, warm):

| input | German | asrMs | mtMs | totalMs |
|---|---|---|---|---|
| browser-built WAV, segment 1 | Hallo, willkommen zur Besprechung. | 545 | 148 | 693 |
| browser-built WAV, segment 2 | Heute werden wir über die Quartalsergebnisse sprechen. | 551 | 204 | 755 |

The Worker adds about 10 ms locally. Through a `trycloudflare.com` quick tunnel, measured warm from the same machine: server-side **774–951 ms**, but **1.71–2.51 s** round trip, so the tunnel costs roughly 0.8–1.5 s. That pushes captions past the 1 s target; a named tunnel on your own domain, or a same-LAN client, should do better. Not yet tested from a remote network.

### Free-tier notes (check current limits before relying on them)

- Workers free: 100k requests/day. One request per utterance, so about 10k utterances per hour of speech is far below that. Static assets are free.
- Free-plan CPU limit is 10 ms per request. Hybrid mode only waits on `fetch`, which does not count. In `workersai` mode the base64 encode of a WAV up to 256 KB is the main CPU cost. It should fit, but this is unmeasured.
- Workers AI: free daily neuron allowance, then billed. Whisper turbo is billed per audio minute, m2m100 per token. Cost per hour of captions is not measured.

### Unverified

- **The whole `workersai` path.** The request shapes follow the Cloudflare model schemas (checked 2026-11-16): whisper takes `audio` as a base64 string and returns `text` and `transcription_info.language`; m2m100 takes `{text, source_lang, target_lang}` and returns `translated_text`. None of it has been run, and latency and quality are unknown.
- Deployed behavior: assets binding, secrets, latency over a tunnel.
- The browser mic path against the Worker. The VAD and WAV encoder were tested in Node; the AudioWorklet capture was not changed.

## Verification recording

`verify/media/caption-proof.mp4` is a 1280x720 recording with audio of the real page producing three German captions end to end. See [verify/README.md](verify/README.md) for the numbers, how it was captured, and what it does not prove.
