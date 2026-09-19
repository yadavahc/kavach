/**
 * Call-level evaluation over the labelled fixture calls (held out from
 * threshold calibration, which used the probe set).
 *
 * A scam call counts as detected only if the warning renders before the
 * caller's extraction turn begins and names an acceptable family: a warning
 * after the OTP has been read out does not protect anyone.
 */
import type { FixtureCall } from "../../corpus/schema";
import type { Family, ScamFamily, Stage } from "../../corpus/taxonomy";
import { overlap } from "../detection/claims";
import type { SimulatedRunResult } from "../detection/drivers";
import { summarize, type LatencySummary } from "../metrics/latency";

export interface CallOutcome {
  fixtureId: string;
  title: string;
  label: "scam" | "benign";
  family: ScamFamily | null;
  warned: boolean;
  warningAt: number | null;
  warnedFamily: Family | null;
  familyAcceptable: boolean | null;
  onsetAt: number | null;
  extractionAt: number | null;
  /** Warning rendered before the extraction turn began. */
  beforeExtraction: boolean | null;
  /** Seconds between the warning and the start of the extraction turn (positive = early). */
  leadSeconds: number | null;
  /** Seconds between the onset turn starting and the warning. */
  sinceOnsetSeconds: number | null;
  stages: { annotated: Stage[]; reached: Stage[] };
  claims: { annotated: number; matched: number; correct: number };
  queries: number;
  callSeconds: number;
  wallMs: number;
  samples: { searchMs: number[]; embedMs: number[]; roundTripMs: number[]; networkMs: number[] };
}

export interface BenchSummary {
  calls: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
  /** Scam calls warned at any time, regardless of timing or family. */
  scamWarnedAnyTime: number;
  familyAccuracy: number;
  meanLeadSeconds: number | null;
  stageRecall: number;
  claimAccuracy: number;
  claimAlignment: number;
  latency: { searchMs: LatencySummary; embedMs: LatencySummary; roundTripMs: LatencySummary; networkMs: LatencySummary };
}

const CLAIM_ALIGN = 0.6;

export function outcomeFor(call: FixtureCall, run: SimulatedRunResult): CallOutcome {
  const s = run.engine.snapshot;
  const w = s.warning;
  const onsetAt = call.onsetTurn === null ? null : call.turns[call.onsetTurn]!.start;
  const extractionAt = call.extractionTurn === null ? null : call.turns[call.extractionTurn]!.start;
  const acceptable = call.family ? [call.family, ...call.acceptableFamilies] : [];

  let annotated = 0;
  let matched = 0;
  let correct = 0;
  call.turns.forEach((turn, i) => {
    for (const claim of turn.claims ?? []) {
      annotated++;
      const candidates = s.claims.filter((c) => c.segmentId === `${call.id}#${i}`);
      const best = candidates.map((c) => ({ c, score: overlap(claim.span, c.text) })).sort((a, b) => b.score - a.score)[0];
      if (!best || best.score < CLAIM_ALIGN) continue;
      matched++;
      if (best.c.verdict === claim.expected && (claim.expected === "unverifiable" || best.c.evidenceId === claim.groundTruthId)) correct++;
    }
  });

  return {
    fixtureId: call.id,
    title: call.title,
    label: call.label,
    family: call.family,
    warned: Boolean(w),
    warningAt: w?.at ?? null,
    warnedFamily: w?.family ?? null,
    familyAcceptable: call.label === "scam" ? Boolean(w && (acceptable as Family[]).includes(w.family)) : null,
    onsetAt,
    extractionAt,
    beforeExtraction: call.label === "scam" ? Boolean(w && extractionAt !== null && w.at < extractionAt) : null,
    leadSeconds: w && extractionAt !== null ? extractionAt - w.at : null,
    sinceOnsetSeconds: w && onsetAt !== null ? w.at - onsetAt : null,
    stages: {
      annotated: [...new Set(call.turns.flatMap((t) => (t.stage ? [t.stage] : [])))],
      reached: s.stages.map((e) => e.stage),
    },
    claims: { annotated, matched, correct },
    queries: run.queries,
    callSeconds: run.callEnd,
    wallMs: run.wallMs,
    samples: {
      searchMs: s.ticks.map((t) => t.latency.searchMs),
      embedMs: s.ticks.map((t) => t.latency.embedMs),
      roundTripMs: s.ticks.map((t) => t.latency.roundTripMs),
      networkMs: s.ticks.map((t) => t.latency.networkMs),
    },
  };
}

export function summarizeBench(outcomes: CallOutcome[]): BenchSummary {
  const scams = outcomes.filter((o) => o.label === "scam");
  const benign = outcomes.filter((o) => o.label === "benign");
  const tp = scams.filter((o) => o.beforeExtraction && o.familyAcceptable).length;
  const fn = scams.length - tp;
  const fp = benign.filter((o) => o.warned).length;
  const tn = benign.length - fp;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const warned = scams.filter((o) => o.warned);
  const leads = scams.flatMap((o) => (o.leadSeconds !== null ? [o.leadSeconds] : []));
  const annotatedStages = scams.reduce((n, o) => n + o.stages.annotated.length, 0);
  const reachedStages = scams.reduce((n, o) => n + o.stages.annotated.filter((st) => o.stages.reached.includes(st)).length, 0);
  const claimsAnnotated = outcomes.reduce((n, o) => n + o.claims.annotated, 0);
  const claimsMatched = outcomes.reduce((n, o) => n + o.claims.matched, 0);
  const claimsCorrect = outcomes.reduce((n, o) => n + o.claims.correct, 0);
  const all = (key: keyof CallOutcome["samples"]) => summarize(outcomes.flatMap((o) => o.samples[key]));

  return {
    calls: outcomes.length,
    tp,
    fp,
    fn,
    tn,
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    scamWarnedAnyTime: warned.length,
    familyAccuracy: warned.length ? warned.filter((o) => o.familyAcceptable).length / warned.length : 0,
    meanLeadSeconds: leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : null,
    stageRecall: annotatedStages ? reachedStages / annotatedStages : 0,
    claimAccuracy: claimsAnnotated ? claimsCorrect / claimsAnnotated : 0,
    claimAlignment: claimsAnnotated ? claimsMatched / claimsAnnotated : 0,
    latency: { searchMs: all("searchMs"), embedMs: all("embedMs"), roundTripMs: all("roundTripMs"), networkMs: all("networkMs") },
  };
}
