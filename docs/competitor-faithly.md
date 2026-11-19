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

## Sources

- https://faithly.live/ and https://faithly.live/privacy.html
- https://app.faithly.live/ (JavaScript bundle)
- https://aws.amazon.com/blogs/mt/author/faracm/ and https://www.linkedin.com/in/canela/
- https://soniox.com/pricing
- https://aws.amazon.com/transcribe/pricing/
- https://aws.amazon.com/translate/pricing/
- https://aws.amazon.com/polly/pricing/
