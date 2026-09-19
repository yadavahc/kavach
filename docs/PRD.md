# Kavach Live: product requirements

## 1. Problem

Phone scams no longer need a convincing stranger. They can use a convincing *you*.

- **Voice cloning.** AI voice cloning turns a few seconds of someone's voice into a usable clone, so "it sounded exactly like my son" or "it was my boss's voice" is no longer evidence of anything.
- **Audio deepfake detectors.** Detectors that look for synthesis artifacts perform well in the lab and degrade sharply in real calls: phone codecs, noise and new synthesis models all cut their accuracy.
- **Who loses.** Losses are large and rising, and they fall hardest on older adults.
- **India.** "Digital arrest" calls have become a wave: fake police or CBI officers keep a victim on a video call for hours until their savings are moved to a "verification account".

The figures behind these statements (clone audio length, detector accuracy drop, annual losses) come from the project brief. Cite primary sources before using them publicly.

## 2. Insight

**Attackers can perfect the voice. They cannot avoid the script, because the script is what extracts the money.**

Scam calls come from a finite, semantically stable set of coercion playbooks:
- digital arrest
- parcel and customs
- KYC expiry
- CEO and vendor wire fraud
- OTP harvesting
- tech support
- romance and advance fee
- cloned relatives in trouble

Each one moves through the same arc: hook, authority claim, isolation, urgency and extraction. The wording varies; the moves do not.

So Kavach does not try to decide whether a voice is synthetic. It asks a question that stays answerable however good cloning gets: *is this caller running a known scam script, and how far along is it?*

## 3. Users

| User | Situation | Need |
|---|---|---|
| Older adult at home | Receives a "police", "bank" or "grandson" call | A calm line to say and permission to hang up |
| Finance or accounts staff | A "CEO" or "supplier" calls asking for an urgent transfer | A prompt to verify through the known channel before paying |
| Family member helping a parent | Wants protection in place before a call happens | Set up a household passphrase and trusted contacts |
| Victim after the fact | Needs to file a cybercrime complaint | A timestamped, verifiable record of the call |

## 4. Why sub-10 ms, on-device retrieval is a hard requirement

Kavach re-queries the rolling transcript every 300 ms, three or more queries a second, for the whole call.

1. **The cadence rules out a network hop per query.** A hosted vector database costs 80 to 300 ms per round trip. At that cost:
   - each result describes speech that is already a fraction of a second old;
   - fewer windows can be examined: 28% fewer on a simulated mobile network in our A/B;
   - a result that should extend a streak can arrive after the streak has broken, which delayed one warning by 6.45 s cross-region.
2. **Privacy decides whether this can ship at all.** A product that streams everyone's phone calls to a server is not one people should install. With in-browser retrieval, the audio and transcript stay on the device.
3. **Measured.** In the browser, Moss answers in 0.16 ms at p50 and 0.30 ms at p99. The full query, dominated by the ONNX embedding of the window, takes 10.0 ms at p50 and 18.6 ms at p99. That leaves more than 280 ms of every 300 ms tick unused.

Moss is load-bearing, not a swapped dependency:
- the two indexes are built and versioned in Moss Cloud and loaded into the page by `@moss-dev/moss-web`;
- every retrieval on the detection path is a Moss WASM search in a Web Worker.

## 5. Goals and non-goals

**Goals**

- Warn before the caller asks for the money or the code, and name the scam family correctly.
- Stay quiet on genuine calls that open the same way: a bank's real fraud alert, a courier, a colleague.
- Give the person something to *say*, not just an alarm.
- Keep call content on the device.
- Make every number shown measured and reproducible.

**Non-goals**

- Deciding whether a voice is synthetic.
- Intercepting the phone network. The prototype listens on speakerphone or replays transcripts.
- Blocking calls automatically.

## 6. Requirements and status

| # | Feature | Acceptance criteria | Status |
|---|---|---|---|
| 1 | Script retrieval engine | Rolling window → playbook index every 300 ms; match panel with pattern, score and stage | Done; Moss search p50 0.16 ms |
| 2 | Atomic claim check | Assertions → ground truth, verdict with source | Done; 75% on dev, **42% on held-out** (weak) |
| 3 | Voice Circle | Trusted contacts, passphrase, out-of-band prompt on impersonation scripts | Done; voice signature is a hint, not proof |
| 4 | Counter-line | Pre-written per family and stage, renders instantly | Done; 40 lines, optional LLM variants (Groq, about 0.7 s) |
| 5 | Coercion pressure meter | Continuous score over four signals across the call | Done |
| 6 | Evidence pack | Timestamped transcript, patterns, confidences, pressure curve; JSON + PDF | Done; SHA-256 digest, built on device |
| 7 | Replay eval bench | Labelled scam and benign calls, P/R/F1 and retrieval p50/p99/p99.9 | Done; in-app and `npm run eval` |
| 8 | Latency A/B toggle | Same call and pipeline, on-device vs simulated hosted, TTFW side by side | Done; three network profiles |
| – | Graceful degradation | Runs from fixture transcripts when mic or STT is unavailable | Done |
| – | Live latency readout | Actual Moss query times in the app header | Done |

## 7. Architecture summary

```
mic → speech-to-text → rolling 8 s window ──► worker: ONNX embed → Moss WASM search → cosine re-score
                              │                                                          │
                     finished utterances ──► assertion split ──► ground-truth search ──► claim verdicts
                                                                                         │
                          decision rule (watch → warning) ◄─────────────────────────────┘
                                   │
            warning + counter-line · stage track · pressure meter · Voice Circle · evidence pack
```

The server is thin. It builds and publishes the indexes (content-addressed and versioned), serves the Moss credentials, and optionally phrases counter-line variants. See [ARCHITECTURE.md](ARCHITECTURE.md).

## 8. Evaluation

All calls are synthetic transcripts written for this project, and the three sets are kept disjoint by automated leakage checks.

| Set | Use | Calls | Result |
|---|---|---|---|
| Probes | Retrieval quality | 32 + 18 | Moss top-1 family 93.8%, top-3 100%; evidence top-1 100% |
| Dev | Decision-rule calibration | 12 | F1 0.909 (5 TP, 0 FP, 1 FN, 6 TN) |
| Held-out fixtures | Evaluation only | 10 | **F1 0.857**: precision 75%, recall 100%, family 100%, mean lead 36.6 s |

**What failed first.** The first calibration used single-sentence probes, and on real 8 s windows it warned on every benign call (precision 50%, recall 67%). The fix was the script-progression rule plus a window-shaped dev set. The remaining false alarms are a genuine bank fraud alert and a supplier bank-change callback. Both are hard negatives by design.

**Latency A/B** (6 held-out scam calls, simulated network only):

| Profile | Result age p50, device / hosted | Mean change in time to first warning | Worst |
|---|---|---|---|
| Same-region, 80 ms | 10 / 88 ms | +0.06 s | +0.22 s |
| Cross-region, 180 ms | 10 / 181 ms | +1.27 s | +6.45 s |
| Mobile, 300 ms | 10 / 292 ms | +0.63 s | +1.71 s |

## 9. Risks

| Risk | Mitigation |
|---|---|
| False alarms on genuine calls erode trust | The watch state absorbs single-stage matches; benign contrast entries compete in the index; grow the benign set |
| Scripts evolve | New phrasings are a corpus edit plus `index:build`; content-addressed indexes let clients hot-swap versions |
| Moss key visible in the browser | Public-corpus-only project; key served from server env and rotatable |
| Speech recognition leaves the device on some browsers | Mode labelled in the UI; roadmap moves to WASM speech-to-text |
| Moss Node SDK model download fails (401) | Browser path unaffected; reported to Moss |
| Small, synthetic evaluation set | Expand the dev and held-out sets with consented real-world scripts |

## 10. Roadmap

1. Speaker separation, so the window carries only the caller's words.
2. On-device streaming speech-to-text everywhere (WASM Whisper or Moonshine).
3. Hindi, Hinglish, Tamil and Bengali playbooks.
4. Android dialer integration (`InCallService`) instead of speakerphone.
5. More benign hard negatives, and ground-truth claims targeting the observed claim-check failures.
6. Raw similarity scores from the Moss SDK, removing the separate document embeddings.
