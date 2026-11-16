# Verification recording (with audio)

Proof that the browser path works end to end, not just the HTTP endpoints. Captured on a GTX 1060 box running whisper.cpp (CPU) and Hy-MT2-1.8B Q4 (Vulkan) behind the Node server.

**Artifacts**

| File | What |
|---|---|
| `media/caption-proof.mp4` | English→German, 1280×720 H.264 + AAC, 18.1 s |
| `media/caption-proof-es-zh.mp4` | Spanish→Chinese, same encoding, 19.6 s |
| `media/speech.wav`, `media/speech-es.wav` | The exact speech fed in, both clips |
| `media/final.png`, `media/final-es-zh.png` | Final frames |
| `media/timing.json`, `media/timing-es-zh.json` | Capture timings and each caption's latency line |

Both recordings show the real page: real AudioWorklet resampling, real VAD, real whisper, real Hy-MT2, real token streaming. Neither is a mock and neither is paced.

## English → German

1. Page loads; health check reports `node → German`.
2. "Start mic" is clicked at 1.85 s; speech starts at 2.85 s (the WAV opens with 1 s of silence).
3. Three sentences go through the page's real audio path (AudioWorklet → 16 kHz downsample → energy VAD).
4. The **source line appears when ASR finishes**, then the translation fills in **as the model emits tokens**.

| German | Source | ASR | MT | total |
|---|---|---|---|---|
| Hallo, willkommen zur Besprechung. | Hello, welcome to the meeting. | 540 ms | 259 ms | 799 ms |
| Heute werden wir über die Quartalsergebnisse sprechen. | Today we will discuss the quarterly results. | 526 ms | 230 ms | 756 ms |
| Unsere Umsätze stiegen in diesem Quartal um 12%. | Our revenue increased by 12% this quarter. | 530 ms | 265 ms | 795 ms |

## Spanish → Chinese

Config: `SOURCE_LANG=es`, `TARGET_LANG=Simplified Chinese`.

| Chinese | Spanish source | ASR | MT | total |
|---|---|---|---|---|
| 你好，欢迎参加会议。 | Hola, bienvenidos a la reunión. | 341 ms | 95 ms | 436 ms |
| 今天我们将讨论本季度的结果。 | Hoy vamos a hablar de los resultados del trimestre. | 347 ms | 202 ms | 550 ms |
| 本季度我们的收入增长了12%。 | Nuestros ingresos aumentaron un 12% este trimestre. | 383 ms | 197 ms | 580 ms |

CJK renders correctly through system font fallback (Microsoft YaHei); no web font is loaded.

**Source language is the dominant ASR cost.** With whisper auto-detecting, the same segment took 1,649 ms total, 1,461 ms of it ASR, because detection runs an extra encoder pass. Pinning `SOURCE_LANG=es` dropped it to 460 ms warm. For a fixed pair, always pin it.

Speech for this clip came from Edge TTS (`es-ES-ElviraNeural`); Windows SAPI only has en-US voices on this machine. Piper was tried first and its Spanish voices crash the Windows binary with `"aɪ" is not a single codepoint` — a phoneme-map incompatibility, not bad data.

## Real streaming, not paced

`POST /api/segment/stream` forwards llama-server's SSE deltas straight to the page. Measured on a single English segment:

```
+ 560 ms  src        (ASR done, source line appears)
+ 567 ms  delta "H"  (first token, 7 ms later)
+ 580 ms  delta "allo"
+ 593 ms  delta ","
+ 709 ms  done
11 delta frames, 12 tokens, ~140 ms of generation
```

The model emits a whole caption in about **140 ms**. The reveal speed on screen is the model's real speed — nothing is held back and there is no fixed per-word delay.

An earlier version paced words at up to 170 ms each, which looked more "realtime" than the system is and added ~700 ms on top of finished work. It was removed.

| Detail | Choice |
|---|---|
| Word entrance | CSS `transition` on `opacity` + `translateY(0.18em)`, 180 ms, `cubic-bezier(0.23, 1, 0.32, 1)` |
| Trigger | per-token `delta` event, class flipped on the word's own span |
| List shift | FLIP via `element.animate()` on `transform`, 220 ms, same curve |
| Latency line | fades in on `done` |
| Reduced motion | `prefers-reduced-motion` drops the transform, keeps a 120 ms opacity fade |

Only `transform` and `opacity` animate.

## How it was captured and synced

No microphone was available, so `navigator.mediaDevices.getUserMedia` is stubbed before page load to return a `MediaStream` built from the clip. Everything downstream is the real code.

Playwright records video without audio, so the speech is muxed back in afterwards:

1. The init script records `performance.now()` at `src.start()` and at each caption insertion → `timing*.json`.
2. `ffmpeg -itsoffset <measured audio start>` shifts the WAV into place.
3. Sync checked by extracting frames: 6.10 s shows only the source line, 6.23 s shows `Hallo, willkommen` mid-fade with the rest absent, 6.67 s shows the finished line.

Accuracy is roughly ±100 ms.

```powershell
# stack running: .\start.ps1   (with $env:APP_TOKEN set)
cd verify
npm install && npx playwright install chromium
node record.js media\speech.wav "http://127.0.0.1:3000/?token=YOUR_TOKEN"
ffmpeg -i video/silent.webm -itsoffset <audioStartPerf/1000> -i media\speech.wav `
  -map 0:v -map 1:a -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p `
  -c:a aac -b:a 128k -movflags +faststart video/caption-proof.mp4
```

## Honest limits

- The microphone is simulated. A real mic adds OS/driver latency not in these numbers.
- Recorded against Node over localhost, not through the Cloudflare tunnel (1.71–2.51 s round trip there).
- The Workers AI backend has no token streaming, so it emits the whole line as one delta. It does not pretend otherwise.
- Two runs, one machine. Speech is synthetic in both clips.
- Translation quality was eyeballed, not scored. No chrF/COMET was computed for either pair.
