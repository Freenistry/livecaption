# How cloud services get their caption speed (research, 2026-11-19)

Question: the README says no hardware removes the 0.5 s pause or the 80 ms audio chunks. How do AWS and the other cloud services get fast captions anyway?

Short answer: **they do not remove those delays either.** Their final results wait for a pause as ours do, and often longer. They seem fast for these reasons:
- They show partials that are stabilized word by word.
- They make words final before the pause.
- They run large GPU fleets, so a request never waits in a queue.

This document reports what vendors publish. We did not run these services (we have no API keys). See `competitor-faithly.md` for a planned side-by-side test.

## 1. The final waits for a pause everywhere, and often longer than ours

| Service | What triggers the final result | Published delay |
|---|---|---|
| **livecaption** | Streaming-CTC endpoint after a pause in speech | **0.5 s pause**, then ~0.3–1.5 s for Parakeet + MT |
| Amazon Transcribe | "a natural speech segment … continuous speech that contains a pause or a change in speaker" (`IsPartial: false`) | No number published. In the AWS docs example, the final arrives 0.3 s after the last partial. |
| Deepgram | VAD endpointing (`speech_final`) | Default 10 ms of silence. This cuts users off mid-answer, so many apps raise it. `UtteranceEnd` needs ≥ 1000 ms, because interim results arrive about every 1 s. |
| Soniox | Semantic endpoint detection, which considers pauses, intonation and context, then an `<end>` token | `max_endpoint_delay_ms` 500–3000, default **2000**, "1500 for lower latency" |
| Speechmatics | `max_delay` for finals | At 2 s, WER is 11.2% vs 10.24% batch (8.5% relative worse). At 10 s it is the same as batch. |
| Azure Speech | `Recognized` event at the end of an utterance | The Live Interpreter API translates only finalized recognition, not partials. |
| Google Meet speech translation | End-to-end audio model, no text stage | **2–3 s by design**: "Faster was difficult to understand." The older cascade took 10–20 s. |

Our 0.5 s pause is at the short end of this range. The services that quote a number wait 1–3 s before they declare a segment final. Deepgram's 10 ms default is the exception, and it splits sentences. We saw the same problem when we tried 0.3 s.

## 2. How they make captions feel fast

1. **Word emission latency, not "final" latency.** Picovoice measured the time from the end of a spoken word to its transcript:

   | Engine | ms |
   |---|---|
   | Amazon Transcribe Streaming | 290 |
   | Nemotron 3.5 ASR Streaming (our non-English ASR) | 450 |
   | Azure | 520 |
   | Picovoice Cheetah | 560 |
   | Moonshine Small / Medium | 650 / 640 |
   | Google | 830 |

   The cloud's speed comes from this partial stream: the viewer reads words while the speaker is still talking. Our grey line is the same idea. It shows a word about 0.4–0.5 s after it is spoken, including about 50 ms of translation.

2. **Partial stabilization (they show partials that do not change).**
   - **AWS:** `enable-partial-results-stabilization` with a low, medium or high level. Each word gets a `Stable` flag, and stable words never change. AWS recommends this for live subtitles: "only the last few words … can change". High stability is faster but slightly less accurate.
   - **Azure:** `StablePartialResultThreshold=N` sends a word only after it has been recognized N times.
   - **Ours:** livecaption does a simpler version on the translated text. For zh and ja it shows only the prefix that two consecutive translations agree on, and other languages get at most one rewrite per second. This cut rewrites from 103 to 21 per 30 s.

3. **Token-level finality before the endpoint (Soniox).** Words become `is_final: true` one by one while the person is still speaking. The `<end>` token only closes the segment. A final caption can therefore lag the speech by much less than the endpoint delay.

4. **Small audio chunks.** AWS recommends 50–200 ms chunks (32 KB max). Our 80 ms is inside that range, so chunk size is not where we lose time.

5. **Dedicated, over-provisioned GPU fleets.** Models stay loaded, requests are batched across customers, and there is enough capacity that a request does not wait. This is the step where our 4-target run lost time: 10–30 s waits at p90 on one GTX 1060. The cloud does not have that queue, because it buys capacity for peak load.

6. **Translation is a separate, short call.**
   - **Amazon Translate:** sentence-level NMT. AWS publishes no per-request latency ("sub-second"; measure it with the CloudWatch metric).
   - **Cascaded AWS pipelines** (for example the aws-samples live-translation sample and Faithly) translate each final segment. Their stated end-to-end time is about 1–2 s.
   - **Ours:** livecaption's final path is the same: endpoint, then ASR re-read, then MT.

7. **End-to-end models (Google).** Google's speech-to-speech model has no transcribe → translate → speak stages that add up. Google still chose a 2–3 s delay for listeners. Fast output alone is not the goal; it has to be understandable.

## 3. What this means for livecaption

| Cloud technique | We have it? | Worth adding? |
|---|---|---|
| Small audio chunks (50–200 ms) | Yes, 80 ms | – |
| Partials shown immediately (grey line) | Yes, ~50 ms translation | – |
| Partial stabilization | Yes, simpler (agreed prefix / 1 rewrite per s) | Maybe: a per-word stable flag would let the page show stable words in black before the final arrives |
| Token-level finality before the pause | No | **Yes, the biggest win.** Translate the stable prefix of a long segment with Hy-MT2 while the speaker continues. Then the white line no longer waits for the end of the segment. |
| Semantic endpointing | No (silence only) | Maybe: end the segment sooner when a sentence is clearly complete, and wait longer when it is not. This is the real fix for the 0.5 s pause; a shorter fixed silence split clauses in eval.js. |
| No queue for MT | No (one GTX 1060 for all targets) | Yes, through hardware or one llama-server per target. See README "Faster hardware". |
| End-to-end speech model | No | Not now. No open model of this kind covers our 15 targets offline. |

**Conclusion.** For local hosting, the cloud speed is reachable without the cloud:
1. Fix the MT queue with a faster GPU or one server per target. This brings p90 down to about the p50 we already measured (0.3–1.7 s).
2. Add token-level finality: translate stable text before the pause.

The 0.5 s pause is already shorter than most of the cloud services that publish a number.

## Sources

- AWS, streaming and partial results / partial-result stabilization: https://docs.aws.amazon.com/transcribe/latest/dg/streaming-partial-results.html
- AWS, result stabilization: https://docs.aws.amazon.com/transcribe/latest/dg/result-stabilization.html
- AWS, StartStreamTranscription (chunk size): https://docs.aws.amazon.com/transcribe/latest/APIReference/API_streaming_StartStreamTranscription.html
- AWS, subtitle accuracy for live broadcasts: https://aws.amazon.com/blogs/media/what-was-that-increasing-subtitle-accuracy-for-live-broadcasts-using-amazon-transcribe/
- AWS, Amazon Translate real-time API: https://docs.aws.amazon.com/translate/latest/dg/sync-api.html
- AWS sample, live translation: https://github.com/aws-samples/amazon-live-translation-polly-transcribe
- Picovoice speech-to-text benchmark (word emission latency): https://github.com/Picovoice/speech-to-text-benchmark
- Deepgram endpointing: https://developers.deepgram.com/docs/endpointing
- Deepgram end-of-speech detection / UtteranceEnd: https://developers.deepgram.com/docs/understanding-end-of-speech-detection
- Deepgram endpointing=300 cut-off report: https://dev.to/ji_ai/deepgram-endpointing300-cut-off-22-of-my-voice-ai-users-mid-answer-2a2n
- Soniox endpoint detection: https://docs.soniox.com/stt/rt/endpoint-detection
- Speechmatics real-time latency vs accuracy: https://www.speechmatics.com/company/articles-and-news/best-in-class-real-time-asr-system
- Azure captioning concepts (stable partial threshold): https://learn.microsoft.com/en-us/azure/ai-services/speech-service/captioning-concepts
- Azure Live Interpreter (finalized results only): https://learn.microsoft.com/en-nz/answers/questions/5750022/how-to-use-the-live-interpreter-api
- Google Meet speech translation: https://blog.google/products-and-platforms/products/workspace/google-meet-langauge-translation-ai/
