/**
 * Detection state machine. Drivers feed it retrieval results stamped with call
 * time; it owns the watch and warning rules, per-family stage evidence, the
 * coercion pressure curve, claim verdicts and the Voice Circle trigger.
 * No I/O happens here.
 *
 * The warning follows the product's premise that a scam is a script that
 * progresses: a single matched stage only puts the call on watch (genuine banks
 * and couriers open the same way a hook does); the warning needs a same-family
 * streak that persists in call time and a family whose script has matched the
 * required number of distinct stages (optionally including a coercion stage).
 */
import { STAGE_ORDER, type Family, type Impersonation, type ScamFamily, type Stage, type Verdict } from "../../corpus/taxonomy";
import type { CorpusBundle } from "../corpus/client-data";
import type { ClientQueryResult } from "../moss/client";
import type { RetrievedHit } from "../moss/protocol";
import { DETECTION, type DetectionConfig } from "./config";
import { assessPlaybooks, checkClaim, instantPressure, type PlaybookAssessment, type SignalVector } from "./scoring";

export interface LatencySample {
  embedMs: number;
  searchMs: number;
  rescoreMs: number;
  /** embed + search + re-score inside the worker. */
  workerMs: number;
  /** What the pipeline experienced, including any simulated network time. */
  roundTripMs: number;
  networkMs: number;
}

export interface TickRecord {
  index: number;
  /** Call time (s) when the query was issued. */
  at: number;
  /** Call time (s) when the result was applied. */
  resolvedAt: number;
  window: string;
  hits: RetrievedHit[];
  assessment: PlaybookAssessment;
  latency: LatencySample;
}

export interface ClaimRecord {
  id: string;
  at: number;
  resolvedAt: number;
  text: string;
  segmentId: string;
  verdict: Verdict;
  evidenceId: string | null;
  cosine: number;
  /** Ground-truth top-k re-scored by cosine. */
  hits: RetrievedHit[];
  latency: LatencySample;
}

export interface StageEvent {
  stage: Stage;
  at: number;
  entryId: string;
  cosine: number;
}

export interface WarningRecord {
  /** Call time (s) the warning rendered: when the confirming result arrived. */
  at: number;
  /** Call time (s) the confirming query was issued. */
  issuedAt: number;
  family: Family;
  stage: Stage | "none";
  entryId: string;
  cosine: number;
  impersonates: Impersonation;
}

export interface WatchState {
  family: ScamFamily;
  stage: Stage | "none";
  since: number;
  entryId: string;
  cosine: number;
}

export interface PressurePoint {
  t: number;
  composite: number;
  signals: SignalVector;
}

export interface FamilyEvidence {
  results: number;
  stages: Partial<Record<Stage, StageEvent>>;
}

export interface EngineSnapshot {
  ticks: TickRecord[];
  claims: ClaimRecord[];
  /** Stage progression of the leading family (the warned family once a warning fires). */
  stages: StageEvent[];
  familyEvidence: Partial<Record<ScamFamily, FamilyEvidence>>;
  pressure: PressurePoint[];
  watch: WatchState | null;
  warning: WarningRecord | null;
  current: { family: Family; stage: Stage | "none"; confidence: number; entryId: string | null; cosine: number };
  /** Consecutive scam-signal results naming the same family. */
  consecutive: number;
  signalFamily: ScamFamily | null;
  streakStart: number | null;
  lastSignalAt: number | null;
  impersonationAlert: { at: number; entryId: string; family: Family } | null;
}

const EMPTY: EngineSnapshot = {
  ticks: [],
  claims: [],
  stages: [],
  familyEvidence: {},
  pressure: [],
  watch: null,
  warning: null,
  current: { family: "benign", stage: "none", confidence: 0, entryId: null, cosine: 0 },
  consecutive: 0,
  signalFamily: null,
  streakStart: null,
  lastSignalAt: null,
  impersonationAlert: null,
};

const latencyOf = (r: ClientQueryResult): LatencySample => ({
  embedMs: r.embedMs,
  searchMs: r.searchMs,
  rescoreMs: r.rescoreMs,
  workerMs: r.totalMs,
  roundTripMs: r.roundTripMs,
  networkMs: r.networkMs,
});

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

function stageList(evidence: FamilyEvidence | undefined): StageEvent[] {
  return evidence ? Object.values(evidence.stages).filter((e): e is StageEvent => Boolean(e)).sort((a, b) => a.at - b.at) : [];
}

export class DetectionEngine {
  private state: EngineSnapshot = EMPTY;
  private readonly listeners = new Set<(s: EngineSnapshot) => void>();

  constructor(
    private readonly bundle: Pick<CorpusBundle, "playbookById" | "groundTruthById">,
    readonly cfg: DetectionConfig = DETECTION,
  ) {}

  get snapshot(): EngineSnapshot {
    return this.state;
  }

  subscribe(fn: (s: EngineSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  reset(): void {
    this.commit(EMPTY);
  }

  applyTick(at: number, resolvedAt: number, window: string, result: ClientQueryResult): TickRecord {
    const s = this.state;
    const cfg = this.cfg;
    const raw = assessPlaybooks(result.hits, this.bundle.playbookById, cfg);
    // Short windows (call openers) match generic hooks too easily to count as evidence.
    const assessment: PlaybookAssessment = wordCount(window) >= cfg.decisionMinWords ? raw : { ...raw, scamSignal: false, family: "benign", stage: "none" };
    const record: TickRecord = { index: s.ticks.length, at, resolvedAt, window, hits: result.hits, assessment, latency: latencyOf(result) };

    // Pressure: exponential smoothing in call time.
    const inst = instantPressure(result.hits, this.bundle.playbookById, cfg);
    const last = s.pressure.at(-1);
    const dt = last ? Math.max(0, resolvedAt - last.t) : resolvedAt;
    const k = 1 - Math.exp(-dt / cfg.pressureTauSeconds);
    const prev = last ?? { composite: 0, signals: { urgency: 0, isolation: 0, secrecy: 0, authority: 0 } };
    const point: PressurePoint = {
      t: resolvedAt,
      composite: prev.composite + k * (inst.composite - prev.composite),
      signals: {
        urgency: prev.signals.urgency + k * (inst.signals.urgency - prev.signals.urgency),
        isolation: prev.signals.isolation + k * (inst.signals.isolation - prev.signals.isolation),
        secrecy: prev.signals.secrecy + k * (inst.signals.secrecy - prev.signals.secrecy),
        authority: prev.signals.authority + k * (inst.signals.authority - prev.signals.authority),
      },
    };

    const best = assessment.scamSignal ? assessment.bestScam : null;
    const family = best && best.family !== "benign" ? best.family : null;
    const continuing = family !== null && family === s.signalFamily;
    const consecutive = family === null ? 0 : continuing ? s.consecutive + 1 : 1;
    const streakStart = family === null ? null : continuing ? s.streakStart : resolvedAt;

    let { familyEvidence, warning, impersonationAlert, watch } = s;
    let current = s.current;

    if (best && family) {
      const ev = familyEvidence[family] ?? { results: 0, stages: {} };
      const stages = best.stage !== "none" && !ev.stages[best.stage] ? { ...ev.stages, [best.stage]: { stage: best.stage, at: resolvedAt, entryId: best.id, cosine: best.cosine } } : ev.stages;
      familyEvidence = { ...familyEvidence, [family]: { results: ev.results + 1, stages } };

      const matched = Object.keys(stages) as Stage[];
      const coercive = matched.some((st) => STAGE_ORDER[st] >= STAGE_ORDER.isolation);
      const sustained = consecutive >= cfg.warnConsecutive && streakStart !== null && resolvedAt - streakStart >= cfg.warnMinSpanSeconds;
      const escalated = (!cfg.requireCoercion || coercive) && matched.length >= cfg.minDistinctStages;
      const entry = this.bundle.playbookById.get(best.id);

      if (!warning && sustained && escalated) {
        warning = { at: resolvedAt, issuedAt: at, family, stage: best.stage, entryId: best.id, cosine: best.cosine, impersonates: entry?.impersonates ?? "none" };
      }
      if (!impersonationAlert && sustained && entry?.impersonates === "known_contact") {
        impersonationAlert = { at: resolvedAt, entryId: best.id, family };
      }
      watch = { family, stage: best.stage, since: streakStart ?? resolvedAt, entryId: best.id, cosine: best.cosine };
      current = { family, stage: best.stage, confidence: assessment.confidence, entryId: best.id, cosine: best.cosine };
    } else {
      if (watch && (s.lastSignalAt === null || resolvedAt - s.lastSignalAt > cfg.watchHoldSeconds)) watch = null;
      current = { family: "benign", stage: "none", confidence: assessment.confidence, entryId: assessment.lead?.id ?? null, cosine: assessment.lead?.cosine ?? 0 };
    }

    const leading =
      (warning?.family as ScamFamily | undefined) ??
      (Object.entries(familyEvidence) as [ScamFamily, FamilyEvidence][]).sort((a, b) => b[1].results - a[1].results)[0]?.[0];
    const stagesOut = leading ? stageList(familyEvidence[leading]) : [];

    this.commit({
      ...s,
      ticks: [...s.ticks, record],
      pressure: [...s.pressure, point],
      consecutive,
      signalFamily: family,
      streakStart,
      lastSignalAt: family ? resolvedAt : s.lastSignalAt,
      familyEvidence,
      stages: stagesOut,
      watch: warning ? null : watch,
      warning,
      impersonationAlert,
      current,
    });
    return record;
  }

  applyClaim(at: number, resolvedAt: number, text: string, segmentId: string, result: ClientQueryResult): ClaimRecord {
    const v = checkClaim(result.hits, this.bundle.groundTruthById, this.cfg);
    const record: ClaimRecord = {
      id: `claim-${this.state.claims.length + 1}`,
      at,
      resolvedAt,
      text,
      segmentId,
      verdict: v.verdict,
      evidenceId: v.evidence?.id ?? null,
      cosine: v.cosine,
      hits: result.hits,
      latency: latencyOf(result),
    };
    this.commit({ ...this.state, claims: [...this.state.claims, record] });
    return record;
  }

  private commit(next: EngineSnapshot): void {
    this.state = next;
    for (const fn of this.listeners) fn(next);
  }
}
