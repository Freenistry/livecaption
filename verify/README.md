# Verification recording (with audio)

Proof that the browser path works end to end, not just the HTTP endpoints. Captured on a GTX 1060 box running whisper.cpp (CPU) and Hy-MT2-1.8B Q4 (Vulkan) behind the Node server.

**Artifacts**

| File | What |
|---|---|
| `media/caption-proof.mp4` | 1280×720 H.264 + AAC, 18.6 s. The real page, speech audible, captions revealed word by word |
| `media/speech.wav` | The source speech that was fed in (48 kHz mono) |
| `media/final.png` | Final frame |
| `media/timing.json` | Raw capture timings, including each caption's latency line |

**What it shows**

1. Page loads; health check reports `node → German`.
2. "Start mic" is clicked at 1.83 s; speech starts at 2.83 s (the WAV opens with 1 s of silence).
3. Three sentences of speech go through the page's real audio path (AudioWorklet → 16 kHz downsample → energy VAD).
4. Each German caption is revealed **word by word**, paced against the length of the utterance.

| German | Source | ASR | MT | total | caption starts at |
|---|---|---|---|---|---|
| Hallo, willkommen zur Besprechung. | Hello, welcome to the meeting. | 515 ms | 309 ms | 824 ms | audio +4.52 s |
| Heute werden wir über die Quartalsergebnisse sprechen. | Today we will discuss the quarterly results. | 540 ms | 208 ms | 748 ms | audio +9.14 s |
| Unsere Umsätze stiegen in diesem Quartal um 12%. | Our revenue increased by 12% this quarter. | 533 ms | 237 ms | 770 ms | audio +14.16 s |

The stack was pre-warmed with one request before recording. A cold first request takes ~2.2 s (1.1 s ASR + 1.1 s MT) — documented, not shown here.

## The word-by-word reveal

| Decision | Choice |
|---|---|
| Purpose | Prevent a whole sentence teleporting in; pace the reader |
| Word reveal | CSS `transition` on `opacity` + `translateY(0.18em)`, 180 ms, `cubic-bezier(0.23, 1, 0.32, 1)` |
| Stagger | `clamp(70, audioMs / words, 170)` ms — paced by how long the speaker actually talked, which `/api/segment` returns as `audioMs` |
| Layout | Every word gets its span up front, so the line reserves its space and never reflows mid-reveal |
| List shift | FLIP via `element.animate()` on `transform`, 220 ms, same curve — older captions slide instead of jumping |
| Latency line | Fades in after the last word lands so it doesn't compete with the text |
| Reduced motion | `prefers-reduced-motion` drops the transform and the stagger, keeps a 120 ms opacity fade |

Only `transform` and `opacity` animate. No layout properties are touched.

## How it was captured and synced

No microphone was available, so `navigator.mediaDevices.getUserMedia` is stubbed before page load to return a `MediaStream` built from `speech.wav`. Everything downstream is the real code: the page's AudioWorklet resampler, the VAD, `POST /api/segment`, whisper-server, llama-server.

Playwright records video without audio, so the speech is muxed back in afterwards:

1. The init script records `performance.now()` at `src.start()` and at each caption insertion → `timing.json`.
2. `ffmpeg -itsoffset 1.833` shifts the WAV to the measured audio-start point.
3. Sync was checked by extracting frames around caption 1's predicted appearance. At 7.80 s only `Hallo,` is visible; at 8.15 s three words are in; the rest are still blank.

Accuracy is roughly ±100 ms: the video timeline starts at page creation, the audio clock starts at navigation, and the gap between them is not directly observable.

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

- The microphone is simulated. A real mic adds OS/driver latency that is not in these numbers.
- Recorded against Node over localhost, not through the Cloudflare tunnel. Through the quick tunnel the same requests measured 1.71–2.51 s round trip.
- The reveal is paced client-side from the finished translation, not streamed token by token from the model. The text is already complete when the first word appears; the stagger is presentation, not partial output.
- One run, one machine, English→German. Speech is Windows SAPI, so it sounds robotic.
