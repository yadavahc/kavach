/**
 * Calibrates the detection rule on window-shaped data, and evaluates it.
 *
 *   npm run calibrate   dev calls: record, sweep the decision rule, write corpus/dist/calibration.json
 *   npm run eval        fixture calls (held out): evaluate DETECTION and the latency A/B,
 *                       write corpus/dist/eval-report.json
 *
 * Every call runs through the real pipeline (runSimulatedCall) with retrieval
 * executed by @moss-dev/moss-web in headless Chrome. The retrieval stream does
 * not depend on the decision thresholds, so on the dev set it is recorded once
 * per call and the decision rule is replayed offline for each candidate.
 * Simulated call time advances by the in-browser retrieval latency (embed +
 * search + re-score); the app additionally pays a worker hop of well under 1 ms.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { CorpusManifest } from "../corpus/docs";
import { CorpusError, loadCorpus } from "../corpus/load";
import type { FixtureCall } from "../corpus/schema";
import { FAMILY_LABELS } from "../corpus/taxonomy";
import { DETECTION, type DetectionConfig } from "../lib/detection/config";
import { runSimulatedCall, type SimulatedRunResult, type SimulationBundle } from "../lib/detection/drivers";
import { DetectionEngine, type LatencySample } from "../lib/detection/engine";
import type { DocEmbeddingsFile } from "../lib/detection/vectors";
import { outcomeFor, summarizeBench, type BenchSummary, type CallOutcome } from "../lib/eval/bench";
import { summarize } from "../lib/metrics/latency";
import type { ClientQueryResult, Retriever } from "../lib/moss/client";
import { NETWORK_PROFILES, SimulatedHostedRetriever } from "../lib/moss/hosted-sim";
import type { RetrievedHit } from "../lib/moss/protocol";
import type { MossModelId } from "../lib/moss/runtime";
import { openBrowserSession, VENDOR_URLS } from "./lib/browser-session";
import { c, DIST_DIR, fmtMs, loadEnv, mossCredentials, pct, section, table } from "./lib/cli";

const { values: args } = parseArgs({
  options: {
    set: { type: "string", default: "dev" },
    browser: { type: "string" },
    headed: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
  },
});
if (args.set !== "dev" && args.set !== "fixtures") {
  console.error(c.red("--set must be dev or fixtures"));
  process.exit(2);
}

loadEnv();
const manifestPath = join(DIST_DIR, "manifest.json");
const embeddingsPath = join(DIST_DIR, "doc-embeddings.json");
if (!existsSync(manifestPath) || !existsSync(embeddingsPath)) {
  console.error(c.red("Run npm run index:build and npm run corpus:embed first."));
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CorpusManifest;
const embeddings = JSON.parse(readFileSync(embeddingsPath, "utf8")) as DocEmbeddingsFile;
const corpusVersion = `${manifest.indexes.playbooks.hash}.${manifest.indexes.ground_truth.hash}`;
if (embeddings.corpusVersion !== corpusVersion) {
  console.error(c.red(`doc-embeddings.json is for corpus ${embeddings.corpusVersion}, manifest is ${corpusVersion}. Run npm run corpus:embed.`));
  process.exit(2);
}
let corpus;
try {
  corpus = loadCorpus();
} catch (err) {
  if (err instanceof CorpusError) {
    console.error(c.red(err.message));
    process.exit(1);
  }
  throw err;
}
const creds = mossCredentials();
const PB = manifest.indexes.playbooks.name;
const GT = manifest.indexes.ground_truth.name;
const bundle: SimulationBundle = {
  manifest,
  playbookById: new Map(corpus.playbooks.map((e) => [e.id, e])),
  groundTruthById: new Map(corpus.groundTruth.map((e) => [e.id, e])),
};
const calls = args.set === "fixtures" ? corpus.fixtures : corpus.dev;
if (!calls.length) {
  console.error(c.red(`no ${args.set} calls found`));
  process.exit(2);
}

// ── Helpers ──

const asResult = (hits: RetrievedHit[], l: LatencySample): ClientQueryResult => ({
  hits,
  embedMs: l.embedMs,
  searchMs: l.searchMs,
  rescoreMs: l.rescoreMs,
  totalMs: l.workerMs,
  roundTripMs: l.roundTripMs,
  networkMs: l.networkMs,
});

/** Re-applies a recorded retrieval stream to a fresh engine with a different decision config. */
function replay(call: FixtureCall, run: SimulatedRunResult, cfg: DetectionConfig): CallOutcome {
  const engine = new DetectionEngine(bundle, cfg);
  const s = run.engine.snapshot;
  const events = [
    ...s.ticks.map((t) => ({ at: t.resolvedAt, apply: () => engine.applyTick(t.at, t.resolvedAt, t.window, asResult(t.hits, t.latency)) })),
    ...s.claims.map((cl) => ({ at: cl.resolvedAt, apply: () => engine.applyClaim(cl.at, cl.resolvedAt, cl.text, cl.segmentId, asResult(cl.hits, cl.latency)) })),
  ].sort((a, b) => a.at - b.at);
  for (const e of events) e.apply();
  return outcomeFor(call, { ...run, engine });
}

const resultCell = (o: CallOutcome) => {
  if (o.label === "benign") return o.warned ? c.red("FP") : c.green("TN");
  return o.beforeExtraction && o.familyAcceptable ? c.green("TP") : c.red(o.warned ? "FN (late/wrong family)" : "FN");
};

function outcomeTable(outcomes: CallOutcome[]): string {
  return table(
    ["call", "label", "result", "warning s", "extraction s", "lead s", "warned family", "stages", "claims"],
    outcomes.map((o) => [
      o.fixtureId,
      o.label === "scam" ? o.family! : "benign",
      resultCell(o),
      o.warningAt === null ? "-" : o.warningAt.toFixed(1),
      o.extractionAt === null ? "-" : o.extractionAt.toFixed(1),
      o.leadSeconds === null ? "-" : o.leadSeconds.toFixed(1),
      o.warnedFamily ?? "-",
      o.label === "scam" ? `${o.stages.annotated.filter((st) => o.stages.reached.includes(st)).length}/${o.stages.annotated.length}` : "-",
      o.claims.annotated ? `${o.claims.correct}/${o.claims.annotated}` : "-",
    ]),
  );
}

const summaryRows = (s: BenchSummary): (string | number)[][] => [
  ["precision / recall / F1", `${pct(s.precision)} / ${pct(s.recall)} / ${s.f1.toFixed(3)}`],
  ["TP / FP / FN / TN", `${s.tp} / ${s.fp} / ${s.fn} / ${s.tn}`],
  ["scam calls warned (any time, any family)", `${s.scamWarnedAnyTime}`],
  ["family accuracy (of warned scams)", pct(s.familyAccuracy)],
  ["mean lead before extraction", s.meanLeadSeconds === null ? "-" : `${s.meanLeadSeconds.toFixed(1)} s`],
  ["stage recall", pct(s.stageRecall)],
  ["claim verdict accuracy (aligned)", `${pct(s.claimAccuracy)} (alignment ${pct(s.claimAlignment)})`],
];

const strip = (o: CallOutcome) => {
  const { samples: _samples, ...rest } = o;
  return rest;
};

// ── Record ──

section(`Recording ${calls.length} ${args.set} calls through the pipeline`);
const session = await openBrowserSession({ entry: "scripts/browser/calibrate-entry.ts", isolated: true, browserPath: args.browser, headed: args.headed, verbose: args.verbose });
try {
  const { page } = session;
  const info = await page.evaluate((cfg) => window.__kavach.init(cfg), {
    ...creds,
    model: manifest.model as MossModelId,
    indexes: [PB, GT],
    wasmUrl: VENDOR_URLS.mossWasm,
    onnxWasmPath: VENDOR_URLS.ortDir,
    docVectors: { [PB]: embeddings.indexes.playbooks, [GT]: embeddings.indexes.ground_truth },
  });
  console.log(c.dim(`  runtime ready: ${info.userAgent.match(/(Headless)?Chrome\/[\d.]+/)?.[0] ?? "browser"}, isolated ${info.crossOriginIsolated}, ORT threads ${info.ortNumThreads}`));

  const retriever: Retriever = {
    label: "Moss on-device (moss-web)",
    query: async (index, text, opts) => {
      const r = await page.evaluate((i, t, o) => window.__kavachScored(i, t, o), index, text, opts);
      return { ...r, roundTripMs: r.totalMs, networkMs: 0 };
    },
  };
  for (let i = 0; i < 20; i++) await retriever.query(PB, "warming up the embedder and the index before measuring", { topK: 5, alpha: 1 });

  const runs: { call: FixtureCall; run: SimulatedRunResult }[] = [];
  for (const call of calls) {
    const run = await runSimulatedCall(call, retriever, bundle, { cfg: DETECTION });
    runs.push({ call, run });
    console.log(c.dim(`  ${call.id}: ${run.queries} retrievals over ${run.callEnd.toFixed(0)} s of call, ${(run.wallMs / 1000).toFixed(1)} s wall`));
  }
  const allTicks = runs.flatMap((r) => r.run.engine.snapshot.ticks);
  const latency = {
    embedMs: summarize(allTicks.map((t) => t.latency.embedMs)),
    searchMs: summarize(allTicks.map((t) => t.latency.searchMs)),
    rescoreMs: summarize(allTicks.map((t) => t.latency.rescoreMs)),
    totalMs: summarize(allTicks.map((t) => t.latency.roundTripMs)),
  };
  const latencyTable = () =>
    table(
      ["phase", "n", "p50 ms", "p90 ms", "p99 ms", "p99.9 ms"],
      (Object.entries(latency) as [string, ReturnType<typeof summarize>][]).map(([k, s]) => [k, s.n, fmtMs(s.p50), fmtMs(s.p90), fmtMs(s.p99), fmtMs(s.p999)]),
    );

  if (args.set === "dev") {
    // ── Sweep the decision rule ──
    const grid = {
      scamMin: [0.45, 0.5, 0.55, 0.6, 0.65, 0.7],
      benignMargin: [0, 0.04, 0.08, 0.12],
      warnConsecutive: [2, 3, 5],
      warnMinSpanSeconds: [1, 2.5],
      requireCoercion: [0, 1],
      minDistinctStages: [1, 2],
      decisionMinWords: [8, 12],
    };
    const keys = Object.keys(grid) as (keyof typeof grid)[];
    const points: Record<string, number>[] = [{}];
    for (const k of keys) {
      const next: Record<string, number>[] = [];
      for (const p of points) for (const v of grid[k]) next.push({ ...p, [k]: v });
      points.splice(0, points.length, ...next);
    }
    section(`Sweeping ${points.length} decision configs over ${runs.length} dev calls`);
    const t0 = performance.now();
    const scored = points.map((p) => {
      const cfg = { ...DETECTION, ...p } as DetectionConfig;
      const s = summarizeBench(runs.map((r) => replay(r.call, r.run, cfg)));
      return { p, f1: s.f1, fp: s.fp, tp: s.tp, lead: s.meanLeadSeconds ?? -Infinity, summary: s };
    });
    scored.sort((a, b) => b.f1 - a.f1 || a.fp - b.fp || b.lead - a.lead);
    console.log(c.dim(`  ${((performance.now() - t0) / 1000).toFixed(1)} s`));
    const best = scored[0]!;
    const tied = scored.filter((x) => x.f1 === best.f1 && x.fp === best.fp).length;
    console.log(
      table(
        ["rank", ...keys, "F1", "TP", "FP", "mean lead s"],
        scored.slice(0, 12).map((x, i) => [i + 1, ...keys.map((k) => x.p[k]!), x.f1.toFixed(3), x.tp, x.fp, Number.isFinite(x.lead) ? x.lead.toFixed(1) : "-"]),
      ),
    );
    console.log(c.dim(`  ${tied} configs share the best F1 and FP count; ties broken by the earliest mean warning.`));

    // Claim threshold: 1-D sweep with the chosen decision config.
    const chosenCfg = { ...DETECTION, ...best.p } as DetectionConfig;
    const claimPoints = Array.from({ length: 51 }, (_, i) => Math.round((0.3 + i * 0.01) * 100) / 100).map((claimMatch) => {
      const outcomes = runs.map((r) => replay(r.call, r.run, { ...chosenCfg, claimMatch }));
      const annotated = outcomes.reduce((n, o) => n + o.claims.annotated, 0);
      const correct = outcomes.reduce((n, o) => n + o.claims.correct, 0);
      return { claimMatch, acc: annotated ? correct / annotated : 0 };
    });
    const bestClaim = Math.max(...claimPoints.map((x) => x.acc));
    const plateau = claimPoints.filter((x) => x.acc >= bestClaim - 1e-12);
    const claimMatch = plateau[Math.floor((plateau.length - 1) / 2)]!.claimMatch;
    console.log(c.dim(`  claimMatch plateau ${plateau[0]!.claimMatch}–${plateau.at(-1)!.claimMatch} at ${pct(bestClaim)} → ${claimMatch}`));

    const finalCfg = { ...chosenCfg, claimMatch } as DetectionConfig;
    const finalOutcomes = runs.map((r) => replay(r.call, r.run, finalCfg));
    const finalSummary = summarizeBench(finalOutcomes);
    section("Chosen config on the dev set");
    console.log(outcomeTable(finalOutcomes));
    console.log("\n" + table(["metric", "value"], summaryRows(finalSummary)));
    section("Recording latency (in-browser, dev calls)");
    console.log(latencyTable());

    writeFileSync(
      join(DIST_DIR, "calibration.json"),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          set: "dev",
          calls: runs.map((r) => r.call.id),
          corpusVersion,
          grid,
          chosen: { ...best.p, claimMatch },
          tiedAtBest: tied,
          top: scored.slice(0, 12).map((x) => ({ ...x.p, f1: x.f1, tp: x.tp, fp: x.fp, meanLeadSeconds: Number.isFinite(x.lead) ? x.lead : null })),
          claimSweep: claimPoints,
          devSummary: { ...finalSummary, latency: undefined },
          devOutcomes: finalOutcomes.map(strip),
          recordingLatency: latency,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(c.green("\n✓ wrote corpus/dist/calibration.json"));
    console.log(c.dim(`  Apply to lib/detection/config.ts: ${JSON.stringify({ ...best.p, claimMatch })}`));
  } else {
    // ── Held-out evaluation with the committed DETECTION config ──
    const outcomes = runs.map((r) => outcomeFor(r.call, r.run));
    const summary = summarizeBench(outcomes);
    section("Held-out fixture calls with lib/detection/config.ts");
    console.log(outcomeTable(outcomes));
    console.log("\n" + table(["metric", "value"], summaryRows(summary)));
    section("Retrieval latency (in-browser, fixture calls)");
    console.log(latencyTable());

    // ── Latency A/B: same calls, simulated hosted vector DB network ──
    const scams = runs.filter((r) => r.call.label === "scam");
    const ab: Record<string, unknown>[] = [];
    for (const profile of NETWORK_PROFILES) {
      section(`Latency A/B · ${profile.label} (median RTT ${profile.medianRttMs} ms, σ ${profile.sigma})`);
      const rows: (string | number)[][] = [];
      const deltas: number[] = [];
      for (const { call, run } of scams) {
        const a = outcomeFor(call, run);
        const runB = await runSimulatedCall(call, new SimulatedHostedRetriever(retriever, profile, 42, false), bundle, { cfg: DETECTION });
        const b = outcomeFor(call, runB);
        const aTicks = run.engine.snapshot.ticks;
        const bTicks = runB.engine.snapshot.ticks;
        const delta = a.warningAt !== null && b.warningAt !== null ? b.warningAt - a.warningAt : null;
        if (delta !== null) deltas.push(delta);
        const stale = (ts: typeof aTicks) => summarize(ts.map((t) => (t.resolvedAt - t.at) * 1000)).p50;
        rows.push([
          call.id,
          a.warningAt === null ? "-" : a.warningAt.toFixed(2),
          b.warningAt === null ? "-" : b.warningAt.toFixed(2),
          delta === null ? "-" : `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`,
          a.leadSeconds === null ? "-" : a.leadSeconds.toFixed(1),
          b.leadSeconds === null ? "-" : b.leadSeconds.toFixed(1),
          `${run.queries} / ${runB.queries}`,
          `${fmtMs(stale(aTicks))} / ${fmtMs(stale(bTicks))}`,
        ]);
        ab.push({
          profile: profile.id,
          medianRttMs: profile.medianRttMs,
          sigma: profile.sigma,
          call: call.id,
          onDevice: { warningAt: a.warningAt, leadSeconds: a.leadSeconds, queries: run.queries, roundTripMs: summarize(aTicks.map((t) => t.latency.roundTripMs)) },
          hosted: { warningAt: b.warningAt, leadSeconds: b.leadSeconds, queries: runB.queries, roundTripMs: summarize(bTicks.map((t) => t.latency.roundTripMs)) },
          ttfwDeltaSeconds: delta,
        });
      }
      console.log(table(["call", "TTFW on-device s", "TTFW hosted s", "Δ s", "lead on-device s", "lead hosted s", "retrievals A / B", "window age p50 A / B ms"], rows));
      if (deltas.length) console.log(c.dim(`  mean Δ ${(deltas.reduce((x, y) => x + y, 0) / deltas.length).toFixed(2)} s over ${deltas.length} calls where both arms warned`));
    }

    writeFileSync(
      join(DIST_DIR, "eval-report.json"),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          set: "fixtures",
          corpusVersion,
          runtime: info,
          detection: DETECTION,
          summary: { ...summary, latency: undefined },
          outcomes: outcomes.map(strip),
          retrievalLatency: latency,
          latencyAB: ab,
          familyLabels: FAMILY_LABELS,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(c.green("\n✓ wrote corpus/dist/eval-report.json"));
  }
} catch (err) {
  console.error(c.red(`\n✗ ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
  process.exitCode = 1;
} finally {
  await session.close();
}
