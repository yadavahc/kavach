/**
 * Pure decision rules over Moss hits re-scored with cosine similarity.
 * Shared by the live engine, the eval bench and the CLI verifiers.
 */
import type { Family, GroundTruthEntry, PlaybookEntry, PressureSignal, Stage, Verdict } from "../../corpus/schema";
import type { DetectionConfig } from "./config";
import { cosine } from "./vectors";

export interface RawHit {
  id: string;
  score: number;
}

export interface ScoredHit extends RawHit {
  cosine: number;
}

export function rescore(hits: RawHit[], queryEmbedding: ArrayLike<number>, docVectors: Map<string, Float32Array>): ScoredHit[] {
  return hits
    .map((h) => {
      const v = docVectors.get(h.id);
      return { ...h, cosine: v ? cosine(queryEmbedding, v) : 0 };
    })
    .sort((a, b) => b.cosine - a.cosine);
}

/** Maps cosine to a 0..1 weight between the configured floor and ceiling. */
export function relevance(cos: number, cfg: Pick<DetectionConfig, "cosineFloor" | "cosineCeiling">): number {
  return Math.min(1, Math.max(0, (cos - cfg.cosineFloor) / (cfg.cosineCeiling - cfg.cosineFloor)));
}

export interface PlaybookAssessment {
  family: Family;
  stage: Stage | "none";
  /** Lead entry by cosine. */
  lead: { id: string; cosine: number } | null;
  bestScam: { id: string; cosine: number; family: Family; stage: Stage | "none" } | null;
  bestBenignCosine: number;
  /** bestScam.cosine − bestBenignCosine. */
  margin: number;
  /** Relevance of the best scam entry (0..1). */
  confidence: number;
  /** This result alone meets the scam-signal bar. */
  scamSignal: boolean;
}

export function assessPlaybooks(hits: ScoredHit[], entries: Map<string, PlaybookEntry>, cfg: DetectionConfig): PlaybookAssessment {
  let bestScam: PlaybookAssessment["bestScam"] = null;
  let bestBenignCosine = 0;
  for (const h of hits) {
    const e = entries.get(h.id);
    if (!e) continue;
    if (e.family === "benign") bestBenignCosine = Math.max(bestBenignCosine, h.cosine);
    else if (!bestScam || h.cosine > bestScam.cosine) bestScam = { id: h.id, cosine: h.cosine, family: e.family, stage: e.stage };
  }
  const leadHit = hits[0];
  const leadEntry = leadHit ? entries.get(leadHit.id) : undefined;
  const margin = bestScam ? bestScam.cosine - bestBenignCosine : -1;
  const scamSignal = Boolean(bestScam && bestScam.cosine >= cfg.scamMin && margin >= cfg.benignMargin);
  const family: Family = scamSignal ? bestScam!.family : leadEntry?.family === "benign" || !bestScam ? "benign" : bestScam.family;
  return {
    family,
    stage: scamSignal ? bestScam!.stage : "none",
    lead: leadHit ? { id: leadHit.id, cosine: leadHit.cosine } : null,
    bestScam,
    bestBenignCosine,
    margin,
    confidence: bestScam ? relevance(bestScam.cosine, cfg) : 0,
    scamSignal,
  };
}

export interface ClaimVerdict {
  verdict: Verdict;
  evidence: GroundTruthEntry | null;
  cosine: number;
}

export function checkClaim(hits: ScoredHit[], entries: Map<string, GroundTruthEntry>, cfg: DetectionConfig): ClaimVerdict {
  const top = hits[0];
  const entry = top ? entries.get(top.id) : undefined;
  if (!top || !entry || top.cosine < cfg.claimMatch) return { verdict: "unverifiable", evidence: entry ?? null, cosine: top?.cosine ?? 0 };
  return { verdict: entry.stance === "refutes" ? "false" : "true", evidence: entry, cosine: top.cosine };
}

export type SignalVector = Record<PressureSignal, number>;

export const PRESSURE_WEIGHTS: SignalVector = { urgency: 0.3, isolation: 0.25, secrecy: 0.2, authority: 0.25 };

/**
 * Instantaneous coercion pressure from one retrieval result: the signal
 * intensities of relevant scam entries, relevance-weighted, scaled by the best
 * scam relevance and suppressed when a benign entry matches as well.
 */
export function instantPressure(hits: ScoredHit[], entries: Map<string, PlaybookEntry>, cfg: DetectionConfig): { signals: SignalVector; composite: number } {
  const signals: SignalVector = { urgency: 0, isolation: 0, secrecy: 0, authority: 0 };
  let weightSum = 0;
  let bestScamRel = 0;
  let bestBenignRel = 0;
  for (const h of hits) {
    const e = entries.get(h.id);
    if (!e) continue;
    const rel = relevance(h.cosine, cfg);
    if (e.family === "benign") {
      bestBenignRel = Math.max(bestBenignRel, rel);
      continue;
    }
    bestScamRel = Math.max(bestScamRel, rel);
    weightSum += rel;
    for (const k of Object.keys(signals) as PressureSignal[]) signals[k] += rel * (e.signals[k] / 3);
  }
  const scale = weightSum ? Math.max(0, bestScamRel - bestBenignRel) / weightSum : 0;
  for (const k of Object.keys(signals) as PressureSignal[]) signals[k] *= scale;
  const composite = (Object.keys(PRESSURE_WEIGHTS) as PressureSignal[]).reduce((sum, k) => sum + PRESSURE_WEIGHTS[k] * signals[k], 0);
  return { signals, composite };
}
