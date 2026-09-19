/**
 * Detection constants.
 *
 * Retrieval thresholds were first calibrated on single-sentence probes, which
 * proved too permissive on live 8-second windows: every benign call warned in
 * its opening seconds. The decision rule is now calibrated on window-shaped
 * data: 12 dev calls (corpus/data/dev), replayed through the full pipeline by
 * `npm run calibrate` on 2026-09-19. On the dev set the chosen rule scored
 * F1 0.909 (5 TP, 0 FP, 1 FN); 146 of 1,152 grid points tied at that score and
 * the tie was broken, as declared in scripts/calibrate.ts, by earliest mean
 * warning. The fixture calls stay held out for `npm run eval`.
 * Change these only with a fresh calibration run (see corpus/dist/calibration.json).
 */

export const DETECTION = {
  /** Rolling transcript window fed to retrieval. */
  windowSeconds: 8,
  /** Retrieval cadence. */
  tickMs: 300,
  /** Moss hybrid weight. 1 = pure semantic: most accurate on this corpus and bit-deterministic. */
  alpha: 1,
  topK: 5,
  claimTopK: 3,
  /** Words required in the window before the first query. */
  minWindowWords: 6,
  /** Words required in the window before a result may count as a scam signal. */
  decisionMinWords: 8,

  /** Cosine at or below which a hit carries no weight. */
  cosineFloor: 0.3,
  /** Cosine at which a hit carries full weight. */
  cosineCeiling: 0.75,
  /** Best scam-entry cosine required to count a result as a scam signal. */
  scamMin: 0.45,
  /** Required lead of the best scam entry over the best benign entry. */
  benignMargin: 0.04,

  /** Consecutive same-family scam signals required before the warning fires. */
  warnConsecutive: 2,
  /** Call-time span the same-family streak must cover (overlapping windows are not independent). */
  warnMinSpanSeconds: 2.5,
  /** 1: the family must have matched a coercion stage (isolation, urgency or extraction) before warning. */
  requireCoercion: 0,
  /** Distinct script stages of the family that must have matched before warning. */
  minDistinctStages: 2,
  /** How long the watch state persists after the last signal. */
  watchHoldSeconds: 4,

  /** Ground-truth cosine required for a true/false verdict; below it the claim is unverifiable. */
  claimMatch: 0.38,

  /** Pressure meter smoothing time constant (seconds of call time). */
  pressureTauSeconds: 3,
} satisfies Record<string, number>;

export type DetectionConfig = { readonly [K in keyof typeof DETECTION]: number };
