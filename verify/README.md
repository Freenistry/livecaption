# Verification recording

Proof that the browser path works end to end, not just the HTTP endpoints. Generated on a GTX 1060 box running whisper.cpp (CPU) + Hy-MT2-1.8B Q4 (Vulkan) behind the Node server.

**Artifacts**

- `media/caption-proof.webm` — 1280×720 screen recording of the real page
- `media/final.png` — final frame

**What it shows**

1. Page loads, health check reports `node → German`.
2. "Start mic" is clicked.
3. Three sentences of speech are fed through the page's real audio path (AudioWorklet → 16 kHz downsample → energy VAD).
4. Three German captions appear, each with its latency line.

Captions captured in that run:

| German | Source | ASR | MT | total | round trip |
|---|---|---|---|---|---|
| Hallo, willkommen zur Besprechung. | Hello, welcome to the meeting. | 591 ms | 399 ms | 990 ms | 995 ms |
| Heute werden wir über die Quartalsergebnisse sprechen. | Today we will discuss the quarterly results. | 546 ms | 308 ms | 854 ms | 858 ms |
| Unsere Umsätze stiegen in diesem Quartal um 12%. | Our revenue increased by 12% this quarter. | 591 ms | 319 ms | 910 ms | 914 ms |

## How it was recorded

No microphone was available, so `navigator.mediaDevices.getUserMedia` is stubbed before page load to return a `MediaStream` built from a WAV. Everything downstream of that is the real code: the page's AudioWorklet resampler, the VAD, `POST /api/segment`, whisper-server and llama-server.

```powershell
# 0. stack running:  .\start.ps1   (with $env:APP_TOKEN set)
cd verify
npm install
npx playwright install chromium

# 1. build a speech WAV (PowerShell SAPI, 48 kHz mono) - see README in repo root
# 2. record
node record.js speech.wav "http://127.0.0.1:3000/?token=YOUR_TOKEN"
```

`record.js` writes `video/caption-proof.webm` and `video/final.png`, and prints every caption it saw.

## Honest limits

- The microphone itself is simulated. A real mic adds OS/driver latency that is not in these numbers.
- This ran against Node over localhost, not through the Cloudflare tunnel. Through the quick tunnel the same requests took 1.71–2.51 s round trip.
- One run, one machine, English→German.
