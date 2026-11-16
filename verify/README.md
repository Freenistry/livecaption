# Verification recording (with audio)

Proof that the browser path works end to end, not just the HTTP endpoints. Captured on a GTX 1060 box running whisper.cpp (CPU) and Hy-MT2-1.8B Q4 (Vulkan) behind the Node server.

**Artifacts**

| File | What |
|---|---|
| `media/caption-proof.mp4` | 1280×720 H.264 + AAC, 20.6 s. The real page, with the speech audible |
| `media/speech.wav` | The source speech that was fed in (48 kHz mono) |
| `media/final.png` | Final frame |
| `media/timing.json` | Raw capture timings used to sync the audio |

**What it shows**

1. Page loads; health check reports `node → German`.
2. "Start mic" is clicked at 2.11 s; speech starts at 3.11 s (the WAV opens with 1 s of silence).
3. Three sentences of speech go through the page's real audio path (AudioWorklet → 16 kHz downsample → energy VAD).
4. Three German captions appear, each with its latency line.

| German | Source | ASR | MT | total | caption appears at |
|---|---|---|---|---|---|
| Hallo, willkommen zur Besprechung. | Hello, welcome to the meeting. | 532 ms | 350 ms | 882 ms | audio +4.59 s |
| Heute werden wir über die Quartalsergebnisse sprechen. | Today we will discuss the quarterly results. | 546 ms | 308 ms | 854 ms | audio +9.24 s |
| Unsere Umsätze stiegen in diesem Quartal um 12%. | Our revenue increased by 12% this quarter. | 591 ms | 319 ms | 910 ms | audio +14.09 s |

## How it was captured and synced

No microphone was available, so `navigator.mediaDevices.getUserMedia` is stubbed before page load to return a `MediaStream` built from `speech.wav`. Everything downstream is the real code: the page's AudioWorklet resampler, the VAD, `POST /api/segment`, whisper-server, llama-server.

Playwright records video without audio, so the speech is muxed back in afterwards:

1. The init script records `performance.now()` at `src.start()` and at each caption insertion → `timing.json`.
2. `ffmpeg -itsoffset 2.11` shifts the WAV to the measured audio-start point.
3. Sync was checked by extracting frames at 6.40 s (no caption) and 6.95 s (caption 1 visible). Caption 1 was predicted at 6.70 s.

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
- One run, one machine, English→German.
- The speech is Windows SAPI (robotic), not a human voice.
