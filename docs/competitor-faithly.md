# Competitor research: Faithly (faithly.live)

Researched 2026-11-19. Sources: the public website, the privacy policy, the JavaScript that app.faithly.live sends to the browser, and web search. We did not sign in to the app or call its APIs.

## Summary

Faithly is a Sydney startup, in beta and free for churches. It shows live sermon captions in up to 73 languages and plays a spoken voice in 61 of them. The founder, Matheus Canela, is an AWS Solutions Architect. The stack connects AWS managed AI services and one other vendor for speech recognition. Faithly did not train its own models.

## Third-party services

| Job | Service | Confidence |
|---|---|---|
| Speech to text | **Soniox** real-time API. **Amazon Transcribe** is probably the default or fallback. | Confirmed in code: a `soniox-error` socket event, a per-venue `sonioxEnabled` flag (default off), and a `transcribeLanguages` list. |
| Translation | **Amazon Translate**, or the translation that Soniox includes. | Inference. This runs on the server. The 73 caption languages match the coverage of Amazon Translate (about 75 languages). The languages they list as captions only (Amharic, Georgian, Mongolian, Somali) are in Translate. |
| Spoken voice | **Amazon Polly** | Very likely. The voice picker uses the Polly engine names `standard`, `neural` and `generative`, and it selects voices by `voiceId`. The Amplify bundle has the Polly speech generator. |
| Summaries | **Anthropic Claude** | Confirmed in the privacy policy. |
| Delivery | AWS AppSync GraphQL subscriptions (`OnAudioUpdate(sessionId, language, voiceId)`), Cognito, Amplify, S3, CloudFront, Amazon Location | Confirmed in `config.js` and the app bundle. |
| Audio ingest | Host microphone → socket.io → `audio-{au,uk,br,us}.translate.events` → STT | Confirmed in the app bundle. |
| Analytics | Microsoft Clarity | Confirmed in the CSP header. |

There are four regions: Sydney (ap-southeast-2), London (eu-west-2), São Paulo (sa-east-1) and Oregon (us-west-2). Each church selects one region. Faithly says that captions are about 1–2 s behind the speaker.

The pipeline is the standard AWS recipe: STT → Translate → Polly. AWS publishes it as a sample: [aws-samples/amazon-live-translation-polly-transcribe](https://github.com/aws-samples/amazon-live-translation-polly-transcribe). Most of Faithly's own work is the church product: QR-code join, a language and voice picker for each listener, caption and audio delay (0–20 s) to match livestreams, venue limits, and service reports.

## Price

- **To churches:** free during the beta, with no credit card. They say that they "will keep it free or at a reasonable price". They do not publish a price list.
- **Estimated cost to Faithly**, from list prices. The example is 1 service-hour, about 50,000 spoken characters, 4 target languages and 100 listeners.

| Item | List price | Per service-hour |
|---|---|---|
| Soniox STT (translation included) | $0.12/hr | $0.12 |
| Amazon Transcribe streaming (alternative) | $0.01/min | $0.60 |
| Amazon Translate | $15 / 1M chars | ~$3.00 (4 × ~$0.75) |
| Polly Standard | $4 / 1M chars | ~$0.80 |
| Polly Neural | $16 / 1M chars | ~$3.20 |
| Polly Generative | $30 / 1M chars | ~$6.00 |
| AppSync fan-out | $2 / 1M messages | ~$0.50–1 |
| Claude summary | n/a | cents |

The total is about **$4/hr for captions only**, **$7–8/hr with Neural voice** and **$10–11/hr with Generative voice**. This is about $50–170 per church each month, at about 17 services a month. The cost increases with the number of languages, not the number of listeners. The app code shows these cost controls:

- `allowedEngines` defaults to `["standard"]`.
- `oneVoicePerLanguage` defaults to true. The system makes the speech one time for each language and sends it to all listeners.
- `textOnly` turns off the voice.

AWS Activate credits can probably pay part of the cost.

## What this means for livecaption

- livecaption runs all models locally on our GPU. It has no per-hour cost.
- Gaps compared with Faithly:
  - **Spoken voice (TTS):** a local model such as Piper would do the job of Polly.
  - **Fan-out to many listener phones:** Faithly uses AppSync subscriptions for this. We would need a broadcast channel for each session.
- The final-translation latency of livecaption is about 1 s. This is comparable to the 1–2 s that Faithly states.

## Performance and latency: cloud stack compared with livecaption

We did not run a head-to-head test, because we have no AWS or Soniox keys. The cloud numbers come from published benchmarks and docs. The livecaption numbers are our own measurements (see the README).

| Step | Cloud (Soniox or Transcribe → Translate → Polly) | livecaption (GTX 1060) |
|---|---|---|
| Grey (draft) caption | Transcribe partials ~200–400 ms after speech starts, plus translation and network | ~0.4–0.5 s after a word; the translation part is ~31 ms |
| ASR final after the pause | Soniox ~266 ms median (p95 324 ms); Transcribe ~100–300 ms | Parakeet ~190 ms after the segment cut |
| Final translation | Amazon Translate for each sentence (no published latency) | Hy-MT2 ~390 ms; Bergamot 26–75 ms |
| **End-to-end final caption** | **Faithly states ~1–2 s.** The sum of the steps is ~0.5–0.8 s plus network. | **~0.9–1.2 s after the speaker stops** (warm: Elixir 0.86 s, Node 1.15 s) |
| Spoken voice | Polly Neural ~200 ms to first audio (p95 350 ms) | None yet |
| Network | Phone → cloud region, for example ~100+ ms from the Philippines to Sydney | None on a LAN |

**Accuracy**

- ASR: Soniox has 0.7–1.3% WER on the Pipecat benchmark (clean English). We have not measured our WER on a comparable set. Our own measurement shows that ASR errors and segment cuts cost ~5 chrF points. ASR is our weakest step.
- Translation: no head-to-head test yet. Amazon Translate is a large commercial model and probably wins on the long tail of languages. Our chrF scores for the top 15 languages are in the README.
- Coverage: the cloud has 60 spoken languages, 73 caption languages and voice in 61. livecaption has English plus about 32 spoken languages (Nemotron) and no voice. Neither stack handles Cebuano well.

**Cost and scale**

- Cloud: ~$4–11 per service-hour, which increases with the number of languages. It supports unlimited listeners and needs no hardware.
- livecaption: $0 per hour and one GPU box for each site. It is built for a few viewers. A busy CPU slows the finals to 2–10 s.

**Result:** the cloud is better at accuracy, language coverage, voice and scale. livecaption is better at cost, privacy (audio stays on the box) and draft-caption speed. The final-caption latency of the two is about the same.

**Next step for real numbers:** add Soniox and AWS backends to `eval-live.js` and stream the same FLEURS audio through all of them. This measures latency and chrF side by side. It needs API keys and costs less than $1.

## Event plan: hybrid with on-demand GPUs

Server load depends on the number of languages and stages. It does not depend on the number of listeners. Events last a few hours, so we rent GPUs only for the event.

| Use | Where it runs | Why |
|---|---|---|
| Weekly church services | Local GPU box, or Soniox with a small VM | Low cost for weekly use |
| Large events and conferences | **One rented GPU for each stage**, in a region near the venue | We pay only for the hours of the event |
| Event backup | Soniox is ready as a hot spare | If the GPU fails during a talk, we switch in seconds |

**Example cost:** a conference day of 8 h, 10 languages, 1 stage and 2,000 listeners.

| | Rented GPU (L4 or 4090) | Soniox |
|---|---|---|
| Compute (8 h + 1 h warm-up) | 9 h × $0.69–0.89 ≈ **$6–8** | 10 × 8 h × $0.12 = **$9.60** |
| Voice in 10 languages | Piper on the same GPU: **$0** | 10 × 8 h × $0.70 = **$56** |
| Fan-out to 2,000 phones | Elixir on the same box | Our server is still necessary |
| **Total** | **~$8 for each stage each day** | ~$10 for captions only, ~$66 with voice |

Cost is not the main risk. The risks are reliability and capacity:

1. **GPU availability:** use secure or reserved instances. Do not use spot or community instances, because the provider can take them back during the event. Start the GPU 1 h before the doors open.
2. **Cold start:** bake the models into the Docker image or keep them on a persistent volume. Then a health check must pass before the event goes live.
3. **10 languages on one GPU:** Hy-MT2 processes one request at a time. With 10 targets, the final captions can take more than 2 s. Use llama-server parallel slots (`-np 4`), or use Bergamot for the finals (fast on CPU). Do a load test before the first event.
4. **2,000 WebSockets:** the Elixir server and the network do this work, not the GPU. Do a load test with 2,000 synthetic clients.
5. **Venue internet:** the uplink sends only one audio stream, which is small. Each listener downloads captions and voice, so the venue Wi-Fi or mobile data must carry that traffic.

**Work to do:**
- A start/stop script (RunPod or AWS API) with DNS and TLS
- A GPU Docker image that contains the models
- A Soniox backend for the backup and for weekly services
- Load tests: 10 languages on one GPU, and 2,000 viewers on Elixir

## If cost is not a factor: is the AWS stack the best?

The AWS stack is the most **reliable**: it has SLAs, multiple availability zones, automatic scaling, and 4 regions are already used in production. It is not the **best quality**. These are the problems:

1. **ASR is not the leader.** On published benchmarks, Soniox, Deepgram and AssemblyAI are more accurate than Amazon Transcribe. Faithly added Soniox as an option, which shows that they found the same problem.
2. **Amazon Translate is sentence-level NMT.** It does not use the context of the sermon. It has problems with idioms, Bible names, and words with more than one meaning. Custom terminology lists help only with the terms in the list. LLM translation (for example Claude) gives better quality, but it is slower and costs more.
3. **Latency is 1–2 s, not sub-second.** The audio goes through STT, Translate and Polly, and each step adds a network hop. Faithly states 1–2 s.
4. **The voice is synthetic.** The Standard voices sound robotic. The Generative voices sound good, but they cover fewer languages.
5. **Weak languages are still weak.** For example, Cebuano is not supported in Transcribe, and Translate has no good model for it.
6. **Quotas:** Transcribe streaming has a limit on concurrent streams for each account. Before a large event, check the limit and ask for an increase.
7. **Dependency:** the system needs a good internet connection, the audio leaves the venue, and you are locked in to one vendor.

**The best quality, if cost is not a factor:** Soniox (or Deepgram) for ASR, an LLM for the final translation with the context of the sermon, and ElevenLabs or Polly Generative for the voice. Use AWS only for the infrastructure (AppSync or our Elixir server for fan-out). Reliability then depends on 3 vendors, so for each one, keep a fallback that you can switch to.

## Options when reliability has priority over cost

We do not choose one option here. Choose the option for each event type.

| | **Option 1: AWS managed** (Transcribe → Translate → Polly, AppSync) | **Option 2: Local livecaption** (GPU box at the venue) | **Option 3: AWS primary + local fallback** |
|---|---|---|---|
| Infrastructure reliability | Highest: multi-AZ, SLAs, auto-scaling, AWS support | One box, which is a single point of failure (use a spare box to help) | Highest: each option covers the failure modes of the other |
| Venue internet down | **Captions stop** | **Captions continue** on the local Wi-Fi | Captions continue (local) |
| Region or vendor outage | Session fails unless a second region is ready | Not affected | Local takes over |
| Scale (listeners) | Unlimited | Limited by the venue Wi-Fi and Elixir (requires a load test) | Unlimited online, venue-limited offline |
| Languages | 73 captions, voice in 61 | ~33 spoken languages, voice through Piper | AWS set; local set when on fallback |
| Speech recognition accuracy | Good (Transcribe is below Soniox) | Lower (our weakest step) | AWS level, drops on fallback |
| Final caption latency | ~1–2 s | ~0.9–1.2 s | AWS level |
| Privacy | Audio leaves the venue | Audio stays at the venue | Audio leaves the venue (normal operation) |
| Operations | Raise quotas, 1 region for each session, reconnect long streams (Transcribe stream time limit; check current AWS docs) | Bring the hardware, set it up, keep the models up to date | Both: two systems to test before each event |
| Cost | ~$4–11 per service-hour, scales with languages | Hardware only | Both |

**Catches of AWS, even if cost is not a factor:**

1. The venue internet is the largest risk, and no cloud can fix it.
2. There is no automatic regional failover for a live session.
3. The Transcribe concurrent-stream quota is limited for each account.
4. A Transcribe stream has a time limit, so long events must reconnect without a gap.
5. Three services are in series, so the slowest or failed one stops the captions.
6. The captions arrive reliably, but they can be less accurate than with Soniox.

**Hardening, for every option:**

- Two internet links at the venue (wired + 4G/5G) with failover.
- For large events, a session that is ready in a second region.
- A sound check with the real sound desk 1 h before the event.
- An alert if speech is detected and there are no captions for 5 s.

**Recommended (most reliable):** Option 3. AWS is the primary path, a second region is ready, and the local livecaption box is the fallback if the internet fails.

## Sources

- https://faithly.live/ and https://faithly.live/privacy.html
- https://app.faithly.live/ (JavaScript bundle)
- https://aws.amazon.com/blogs/mt/author/faracm/ and https://www.linkedin.com/in/canela/
- https://soniox.com/pricing
- https://aws.amazon.com/transcribe/pricing/
- https://aws.amazon.com/translate/pricing/
- https://aws.amazon.com/polly/pricing/
- https://www.pipecat.ai/benchmarks/speech-to-text
- https://soniox.com/benchmarks
- https://benchmarks.coval.ai/models/stt-rt-v5
- https://barkingiguana.com/writing/building-a-voice-assistant-transcribe-bedrock-and-polly/ (Transcribe and Polly latencies; one blog, so the numbers are approximate)
- https://creativeminds.dev/blog/voice-integration-amazon-connect-bedrock-polly-streaming-latency/
- https://docs.aws.amazon.com/transcribe/latest/dg/result-stabilization.html
