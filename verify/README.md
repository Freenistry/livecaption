# Verification recording (with audio)

Proof that the browser path works end to end, not just the HTTP endpoints. Captured on a GTX 1060 box running whisper.cpp (CPU) and Hy-MT2-1.8B Q4 (Vulkan) behind the Node server.

**Artifacts**

| File | What |
|---|---|
| `media/caption-proof.mp4` | 1280×720 H.264 + AAC, 18.1 s. The real page, speech audible, translation streamed token by token |
| `media/speech.wav` | The source speech that was fed in (48 kHz mono) |
| `media/final.png` | Final frame |
| `media/timing.json` | Raw capture timings and each caption's latency line |

**What it shows**

1. Page loads; health check reports `node → German`.
2. "Start mic" is clicked at 1.85 s; speech starts at 2.85 s (the WAV opens with 1 s of silence).
3. Three sentences go through the page's real audio path (AudioWorklet → 16 kHz downsample → energy VAD).
4. The **source line appears when ASR finishes**, then the translation fills in **as the model emits tokens**.

| German | Source | ASR | MT | total | starts at |
|---|---|---|---|---|---|
| Hallo, willkommen zur Besprechung. | Hello, welcome to the meeting. | 540 ms | 259 ms | 799 ms | audio +4.22 s |
| Heute werden wir über die Quartalsergebnisse sprechen. | Today we will discuss the quarterly results. | 526 ms | 230 ms | 756 ms | audio +8.90 s |
| Unsere Umsätze stiegen in diesem Quartal um 12%. | Our revenue increased by 12% this quarter. | 530 ms | 265 ms | 795 ms | audio +13.91 s |

The stack was pre-warmed with one request before recording.

## Real streaming, not paced

`POST /api/segment/stream` forwards llama-server's SSE deltas straight to the page. Measured on a single segment:

```
+ 560 ms  src        (ASR done, source line appears)
+ 567 ms  delta "H"  (first token, 7 ms later)
+ 580 ms  delta "allo"
+ 593 ms  delta ","
+ 709 ms  done
11 delta frames, 12 tokens, ~140 ms of generation
```

So the model emits a whole caption in about **140 ms**. The reveal speed on screen is the model's real speed — nothing is held back, and there is no fixed per-word delay. Each word animates in as its token arrives, which is why it reads as a quick, continuous fill rather than a word-by-word trickle.

An earlier version paced words at up to 170 ms each, which looked more "realtime" than the system is and added ~700 ms of delay on top of finished work. It was removed.

| Detail | Choice |
|---|---|
| Word entrance | CSS `transition` on `opacity` + `translateY(0.18em)`, 180 ms, `cubic-bezier(0.23, 1, 0.32, 1)` |
| Trigger | per-token `delta` event, class flipped on the word's own span |
| List shift | FLIP via `element.animate()` on `transform`, 220 ms, same curve |
| Latency line | fades in on `done` |
| Reduced motion | `prefers-reduced-motion` drops the transform, keeps a 120 ms opacity fade |

Only `transform` and `opacity` animate.

## How it was captured and synced

No microphone was available, so `navigator.mediaDevices.getUserMedia` is stubbed before page load to return a `MediaStream` built from `speech.wav`. Everything downstream is the real code.

Playwright records video without audio, so the speech is muxed back in afterwards:

1. The init script records `performance.now()` at `src.start()` and at each caption insertion → `timing.json`.
2. `ffmpeg -itsoffset 1.850` shifts the WAV to the measured audio-start point.
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
- One run, one machine, English→German. Speech is Windows SAPI, so it sounds robotic.
