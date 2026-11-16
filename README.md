# livecaption

Live translated captions POC: mic → 16 kHz PCM16 over WebSocket → energy VAD → whisper.cpp (CPU) → Hy-MT2 1.8B via llama.cpp (Vulkan) → captions in the browser.

Node + one dependency (`ws`). No build step.

## Run (Windows)

```powershell
.\setup.ps1   # downloads whisper.cpp b5454 + ggml-base.bin if missing, npm install, checks ..\bench
.\start.ps1   # whisper-server :8081, llama-server :8099, node :3000; Ctrl+C stops all
```

Open http://localhost:3000 and click **Start mic**.

`setup.ps1` / `start.ps1` expect `llama-server.exe` and `Hy-MT2-Q4.gguf` in `..\bench`. Set `VENDOR_BENCH_DIR` to point elsewhere.

Env (server.js): `PORT=3000`, `ASR_URL=http://127.0.0.1:8081`, `MT_URL=http://127.0.0.1:8099`, `TARGET_LANG=German`, `SOURCE_LANG=auto`.

## Test without a mic

```powershell
# raw PCM16, 16 kHz, mono, no header
curl.exe -X POST --data-binary "@data\test.pcm" http://localhost:3000/selftest
```

This runs the same VAD → ASR → MT path the WebSocket uses.

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
