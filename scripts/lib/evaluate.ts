/**
 * Runtime-agnostic query-correctness + latency evaluation.
 *
 * Retrieval quality is measured on Moss's own ranking. Decisions (scam signal,
 * family, stage, claim verdict) use the calibrated cosine rules from
 * lib/detection/scoring.ts whenever the runtime supplies cosine for each hit.
 * Numbers from different runtimes are reported separately, never substituted.
 */
import type { CorpusManifest } from "../../corpus/docs";
import type { Corpus } from "../../corpus/load";
import type { Family } from "../../corpus/schema";
import type { DetectionConfig } from "../../lib/detection/config";
import { assessPlaybooks, checkClaim, type ScoredHit } from "../../lib/detection/scoring";
import { summarize, type LatencySummary } from "../../lib/metrics/latency";
import { c, fmtMs, pct, section, table } from "./cli";

export interface Hit {
  id: string;
  /** Moss score (rank-derived). */
  score: number;
  /** Cosine similarity to the document, when the runtime can compute it. */
  cosine?: number;
}

export interface QueryOpts {
  topK: number;
  alpha: number;
}

/** Per-query timings. Arrays are empty when a runtime cannot measure that phase. */
export interface BenchSamples {
  totalMs: number[];
  embedMs: number[];
  searchMs: number[];
  rescoreMs: number[];
}

export interface Runtime {
  label: string;
  queryBatch(index: string, texts: string[], opts: QueryOpts): Promise<Hit[][]>;
  bench(index: string, texts: string[], iters: number, opts: QueryOpts): Promise<BenchSamples>;
}

export interface EvalConfig {
  alphas: number[];
  topK: number;
  latencyIters: number;
  verbose: boolean;
  detection: DetectionConfig;
}

export interface EvalResult {
  alphas: Record<string, unknown>;
  latency: Record<string, Partial<Record<keyof BenchSamples, LatencySummary>>>;
  /** Metrics for the first alpha, used for pass/fail gates. */
  gate: { familyAccuracy: number; claimAccuracy: number; calibrated: boolean };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const fmt3 = (x: number) => x.toFixed(3);
const dist = (xs: number[]) => (xs.length ? `min ${fmt3(Math.min(...xs))} · p50 ${fmt3(summarize(xs).p50)} · max ${fmt3(Math.max(...xs))}` : "-");
const byCosine = (hits: Hit[]): ScoredHit[] => hits.map((h) => ({ id: h.id, score: h.score, cosine: h.cosine ?? 0 })).sort((a, b) => b.cosine - a.cosine);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;

/** Returns the median point of the best-accuracy plateau, which is more robust than its first point. */
function plateau<T extends Record<string, number>>(points: (T & { acc: number })[]): T & { acc: number; plateauSize: number } {
  const best = Math.max(...points.map((p) => p.acc));
  const top = points.filter((p) => p.acc >= best - 1e-12);
  const keys = Object.keys(top[0]!).filter((k) => k !== "acc");
  const out = { acc: best, plateauSize: top.length } as T & { acc: number; plateauSize: number };
  for (const k of keys) (out as Record<string, number>)[k] = round2(median(top.map((p) => p[k]!)));
  return out;
}

export async function evaluate(rt: Runtime, corpus: Corpus, manifest: CorpusManifest, cfg: EvalConfig): Promise<EvalResult> {
  if (!cfg.alphas.length || cfg.alphas.some((a) => !Number.isFinite(a) || a < 0 || a > 1)) {
    throw new Error(`alpha must be a comma-separated list of numbers in [0, 1] (got ${cfg.alphas.join(", ") || "none"}); in PowerShell quote it: --alpha '1,0.8'`);
  }
  if (!Number.isInteger(cfg.topK) || cfg.topK < 1) throw new Error(`top-k must be a positive integer (got ${cfg.topK})`);
  if (!Number.isInteger(cfg.latencyIters) || cfg.latencyIters < 1) throw new Error(`latency-iters must be a positive integer (got ${cfg.latencyIters})`);

  const det = cfg.detection;
  const pbById = new Map(corpus.playbooks.map((e) => [e.id, e]));
  const gtById = new Map(corpus.groundTruth.map((e) => [e.id, e]));
  const PB = manifest.indexes.playbooks.name;
  const GT = manifest.indexes.ground_truth.name;

  const alphas: Record<string, unknown> = {};
  let gate: EvalResult["gate"] = { familyAccuracy: 0, claimAccuracy: 0, calibrated: false };

  for (const [ai, alpha] of cfg.alphas.entries()) {
    // ── Playbook retrieval ──
    section(`[${rt.label}] Playbook probes (alpha ${alpha}, topK ${cfg.topK})`);
    const probes = corpus.probes.playbook;
    const results = await rt.queryBatch(PB, probes.map((p) => p.text), { topK: cfg.topK, alpha });
    const calibrated = results.every((r) => r.length > 0 && r.every((h) => typeof h.cosine === "number"));
    const n = probes.length;

    let top1 = 0, top3 = 0, rr = 0;
    let cosTop1 = 0, detected = 0, scamRecall = 0, benignFalse = 0, stageN = 0, stageOk = 0;
    const scamN = probes.filter((p) => p.expectFamily !== "benign").length;
    const benignN = n - scamN;
    const scamBest: number[] = [], scamMargin: number[] = [], benignBest: number[] = [], benignMargin: number[] = [];
    const sweepRows: { expect: Family; bestScam: { cosine: number; family: Family } | null; bestBenign: number }[] = [];
    const failures: string[][] = [];

    probes.forEach((p, i) => {
      const hits = results[i]!;
      const fams = hits.map((h) => pbById.get(h.id)?.family);
      if (fams[0] === p.expectFamily) top1++;
      if (fams.slice(0, 3).includes(p.expectFamily)) top3++;
      const rank = fams.indexOf(p.expectFamily);
      rr += rank >= 0 ? 1 / (rank + 1) : 0;
      if (!calibrated) return;

      const scored = byCosine(hits);
      const a = assessPlaybooks(scored, pbById, det);
      if (pbById.get(scored[0]!.id)?.family === p.expectFamily) cosTop1++;
      const predicted: Family = a.scamSignal ? a.bestScam!.family : "benign";
      if (predicted === p.expectFamily) detected++;
      if (p.expectFamily === "benign") {
        if (a.scamSignal) benignFalse++;
        benignBest.push(a.bestScam?.cosine ?? 0);
        benignMargin.push(a.margin);
      } else {
        if (predicted === p.expectFamily) scamRecall++;
        scamBest.push(a.bestScam?.cosine ?? 0);
        scamMargin.push(a.margin);
        if (p.expectStage && predicted === p.expectFamily) {
          stageN++;
          if (a.stage === p.expectStage) stageOk++;
        }
      }
      sweepRows.push({ expect: p.expectFamily, bestScam: a.bestScam ? { cosine: a.bestScam.cosine, family: a.bestScam.family } : null, bestBenign: a.bestBenignCosine });
      const wrong = predicted !== p.expectFamily || Boolean(p.expectStage && a.scamSignal && a.stage !== p.expectStage);
      if (wrong || cfg.verbose) {
        failures.push([
          wrong ? c.red(p.id) : c.dim(p.id),
          `${p.expectFamily}${p.expectStage ? `/${p.expectStage}` : ""}`,
          a.scamSignal ? `${predicted}/${a.stage}` : "benign (no signal)",
          a.bestScam ? `${a.bestScam.id} ${fmt3(a.bestScam.cosine)}` : "-",
          fmt3(a.bestBenignCosine),
          fmt3(a.margin),
        ]);
      }
    });

    const rankRows: (string | number)[][] = [
      ["Moss top-1 family accuracy", pct(top1 / n)],
      ["Moss top-3 family hit rate", pct(top3 / n)],
      ["Moss family MRR", (rr / n).toFixed(3)],
    ];
    let playbookReport: Record<string, unknown> = { n, top1: top1 / n, top3: top3 / n, mrr: rr / n, calibrated };
    let familyAccuracy = top1 / n;

    if (calibrated) {
      const best = plateau(
        (() => {
          const pts: { scamMin: number; benignMargin: number; acc: number }[] = [];
          for (let s = 0.3; s <= 0.85 + 1e-9; s += 0.01) {
            for (let m = -0.1; m <= 0.2 + 1e-9; m += 0.01) {
              let ok = 0;
              for (const r of sweepRows) {
                const signal = r.bestScam !== null && r.bestScam.cosine >= s && r.bestScam.cosine - r.bestBenign >= m;
                if (r.expect === "benign" ? !signal : signal && r.bestScam!.family === r.expect) ok++;
              }
              pts.push({ scamMin: s, benignMargin: m, acc: ok / sweepRows.length });
            }
          }
          return pts;
        })(),
      );
      familyAccuracy = detected / n;
      rankRows.push(
        ["cosine-reranked top-1 family accuracy", pct(cosTop1 / n)],
        [c.bold("detector accuracy (signal + family)"), c.bold(pct(detected / n))],
        ["scam probes flagged with correct family", `${scamRecall}/${scamN}`],
        ["benign probes falsely flagged", `${benignFalse}/${benignN}`],
        ["stage accuracy (given correct family)", stageN ? pct(stageOk / stageN) : "-"],
      );
      console.log(table(["metric", "value"], rankRows));
      if (failures.length) console.log("\n" + table(["probe", "expected", "detected", "best scam entry (cos)", "best benign cos", "margin"], failures));
      console.log(
        c.dim(
          `\n  best scam cosine   scam probes ${dist(scamBest)} | benign probes ${dist(benignBest)}` +
            `\n  scam − benign      scam probes ${dist(scamMargin)} | benign probes ${dist(benignMargin)}` +
            `\n  current  scamMin ${det.scamMin}, benignMargin ${det.benignMargin} → ${pct(detected / n)}` +
            `\n  probe-optimal plateau (${best.plateauSize} points) median scamMin ${best.scamMin}, benignMargin ${best.benignMargin} → ${pct(best.acc)}  [calibration set, optimistic]`,
        ),
      );
      playbookReport = {
        ...playbookReport,
        cosineTop1: cosTop1 / n,
        detectorAccuracy: detected / n,
        scamRecall: scamRecall / scamN,
        benignFalseAlarmRate: benignFalse / benignN,
        stageAccuracy: stageN ? stageOk / stageN : null,
        bestScamCosine: { scam: summarize(scamBest), benign: summarize(benignBest) },
        margin: { scam: summarize(scamMargin), benign: summarize(benignMargin) },
        thresholds: { scamMin: det.scamMin, benignMargin: det.benignMargin },
        probeOptimal: best,
      };
    } else {
      console.log(table(["metric", "value"], rankRows));
      console.log(c.yellow("  runtime returned no cosine: calibrated detector metrics unavailable (rank metrics only)"));
    }

    // ── Claim check ──
    section(`[${rt.label}] Claim probes (alpha ${alpha})`);
    const claimProbes = corpus.probes.claim;
    const claimHits = await rt.queryBatch(GT, claimProbes.map((p) => p.text), { topK: det.claimTopK, alpha });
    const withId = claimProbes.map((p, i) => ({ p, hits: claimHits[i]! })).filter(({ p }) => p.expectGroundTruthId);
    const top1Evidence = withId.filter(({ p, hits }) => hits[0]?.id === p.expectGroundTruthId).length / withId.length;
    const claimCalibrated = claimHits.every((r) => r.length > 0 && r.every((h) => typeof h.cosine === "number"));
    let claimAccuracy = 0;
    let claimReport: Record<string, unknown> = { n: claimProbes.length, mossTop1Evidence: top1Evidence, calibrated: claimCalibrated };

    if (claimCalibrated) {
      const accAt = (claimMatch: number) =>
        claimProbes.filter((p, i) => {
          const v = checkClaim(byCosine(claimHits[i]!), gtById, { ...det, claimMatch });
          return v.verdict === p.expectVerdict && (v.verdict === "unverifiable" || v.evidence?.id === p.expectGroundTruthId);
        }).length / claimProbes.length;
      claimAccuracy = accAt(det.claimMatch);
      const relevantTop: number[] = [];
      const unrelatedTop: number[] = [];
      const rows: string[][] = [];
      claimProbes.forEach((p, i) => {
        const scored = byCosine(claimHits[i]!);
        (p.expectVerdict === "unverifiable" ? unrelatedTop : relevantTop).push(scored[0]!.cosine);
        const v = checkClaim(scored, gtById, det);
        const ok = v.verdict === p.expectVerdict && (v.verdict === "unverifiable" || v.evidence?.id === p.expectGroundTruthId);
        if (!ok || cfg.verbose) rows.push([ok ? c.dim(p.id) : c.red(p.id), `${p.expectVerdict} ${p.expectGroundTruthId ?? ""}`, v.verdict, scored[0]!.id, fmt3(scored[0]!.cosine)]);
      });
      const pts: { claimMatch: number; acc: number }[] = [];
      for (let t = 0.3; t <= 0.9 + 1e-9; t += 0.01) pts.push({ claimMatch: t, acc: accAt(t) });
      const best = plateau(pts);
      console.log(
        table(
          ["metric", "value"],
          [
            ["Moss top-1 evidence retrieval", pct(top1Evidence)],
            [c.bold(`verdict accuracy @ claimMatch ${det.claimMatch}`), c.bold(pct(claimAccuracy))],
          ],
        ),
      );
      if (rows.length) console.log("\n" + table(["probe", "expected", "got", "top by cosine", "cosine"], rows));
      console.log(
        c.dim(
          `\n  top cosine   claims with evidence ${dist(relevantTop)} | unverifiable claims ${dist(unrelatedTop)}` +
            `\n  probe-optimal plateau (${best.plateauSize} points) median claimMatch ${best.claimMatch} → ${pct(best.acc)}  [calibration set, optimistic]`,
        ),
      );
      claimReport = { ...claimReport, verdictAccuracy: claimAccuracy, claimMatch: det.claimMatch, topCosine: { withEvidence: summarize(relevantTop), unverifiable: summarize(unrelatedTop) }, probeOptimal: best };
    } else {
      console.log(table(["metric", "value"], [["Moss top-1 evidence retrieval", pct(top1Evidence)]]));
      console.log(c.yellow("  runtime returned no cosine: verdicts unavailable"));
    }

    if (ai === 0) gate = { familyAccuracy, claimAccuracy, calibrated: calibrated && claimCalibrated };
    alphas[String(alpha)] = { playbook: playbookReport, claim: claimReport };
  }

  // ── Latency ──
  section(`[${rt.label}] Query latency (alpha ${cfg.alphas[0]})`);
  const opts = (topK: number): QueryOpts => ({ topK, alpha: cfg.alphas[0]! });
  const samples = {
    playbooks: await rt.bench(PB, corpus.probes.playbook.map((p) => p.text), cfg.latencyIters, opts(cfg.topK)),
    ground_truth: await rt.bench(GT, corpus.probes.claim.map((p) => p.text), Math.ceil(cfg.latencyIters / 4), opts(det.claimTopK)),
  };
  const latency: EvalResult["latency"] = {};
  const rows: (string | number)[][] = [];
  for (const [kind, s] of Object.entries(samples)) {
    latency[kind] = {};
    for (const key of ["totalMs", "embedMs", "searchMs", "rescoreMs"] as const) {
      if (!s[key].length) continue;
      const sum = summarize(s[key]);
      latency[kind]![key] = sum;
      const label = { totalMs: "total (embed + search)", embedMs: "  embed (ONNX)", searchMs: "  search (Moss)", rescoreMs: "  cosine re-score" }[key];
      rows.push([`${kind} ${label}`, sum.n, fmtMs(sum.p50), fmtMs(sum.p90), fmtMs(sum.p99), fmtMs(sum.p999), fmtMs(sum.max)]);
    }
  }
  console.log(table(["index / phase", "n", "p50 ms", "p90 ms", "p99 ms", "p99.9 ms", "max ms"], rows));

  return { alphas, latency, gate };
}

export function checkGates(gate: EvalResult["gate"], min: { familyAccuracy: number; claimAccuracy: number }): boolean {
  section("Gates");
  if (!gate.calibrated) {
    console.log(c.red("  calibrated metrics unavailable (no cosine from runtime); gates cannot pass"));
    return false;
  }
  const famOk = gate.familyAccuracy >= min.familyAccuracy;
  const claimOk = gate.claimAccuracy >= min.claimAccuracy;
  console.log(`  detector accuracy ${pct(gate.familyAccuracy)} (min ${pct(min.familyAccuracy)}) ${famOk ? c.green("✓") : c.red("✗")}`);
  console.log(`  claim verdict accuracy ${pct(gate.claimAccuracy)} (min ${pct(min.claimAccuracy)}) ${claimOk ? c.green("✓") : c.red("✗")}`);
  return famOk && claimOk;
}
