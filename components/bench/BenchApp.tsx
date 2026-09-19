"use client";

import { useState } from "react";
import type { FixtureCall } from "@/corpus/schema";
import { FAMILY_LABELS, STAGE_LABELS } from "@/corpus/taxonomy";
import { runSimulatedCall, type SimulatedRunResult } from "@/lib/detection/drivers";
import { clock } from "@/lib/evidence/pack";
import { outcomeFor, summarizeBench, type BenchSummary, type CallOutcome } from "@/lib/eval/bench";
import { summarize, type LatencySummary } from "@/lib/metrics/latency";
import { NETWORK_PROFILES, SimulatedHostedRetriever, type NetworkProfile } from "@/lib/moss/hosted-sim";
import { SiteNav } from "../SiteNav";
import { Chip, Panel, Stat, fmtMs } from "../ui";
import { useRetrieval } from "../useRetrieval";
import { CallTimeline } from "./CallTimeline";

const button = "rounded-md border border-line bg-panel-2 px-3.5 py-2 text-[13px] font-medium text-fg hover:border-accent disabled:cursor-not-allowed disabled:opacity-40";
const select = "rounded-md border border-line bg-ink px-2.5 py-1.5 text-[13px] text-fg";
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

interface Arm {
  label: string;
  outcome: CallOutcome;
  results: { resolvedAt: number; signal: boolean }[];
  roundTrip: LatencySummary;
  network: LatencySummary;
  /** Age of the transcript window when its result arrived. */
  staleness: LatencySummary;
}

function armFrom(label: string, call: FixtureCall, run: SimulatedRunResult): Arm {
  const ticks = run.engine.snapshot.ticks;
  return {
    label,
    outcome: outcomeFor(call, run),
    results: ticks.map((t) => ({ resolvedAt: t.resolvedAt, signal: t.assessment.scamSignal })),
    roundTrip: summarize(ticks.map((t) => t.latency.roundTripMs)),
    network: summarize(ticks.map((t) => t.latency.networkMs)),
    staleness: summarize(ticks.map((t) => (t.resolvedAt - t.at) * 1000)),
  };
}

function verdictOf(o: CallOutcome): { label: string; tone: "ok" | "danger" | "warn" | "neutral" } {
  if (o.label === "benign") return o.warned ? { label: "FP", tone: "danger" } : { label: "TN", tone: "ok" };
  if (o.beforeExtraction && o.familyAcceptable) return { label: "TP", tone: "ok" };
  return { label: o.warned ? "FN (late / wrong family)" : "FN", tone: "danger" };
}

export function BenchApp() {
  const boot = useRetrieval();
  const ready = boot.state === "ready";
  const fixtures = ready ? boot.bundle.corpus.fixtures : [];

  const [progress, setProgress] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<CallOutcome[]>([]);
  const [summary, setSummary] = useState<BenchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [abFixture, setAbFixture] = useState("fx.02.otp_harvest_card_alert");
  const [profile, setProfile] = useState<NetworkProfile>(NETWORK_PROFILES[1]!);
  const [abProgress, setAbProgress] = useState<string | null>(null);
  const [ab, setAb] = useState<{ call: FixtureCall; a: Arm; b: Arm; profile: NetworkProfile } | null>(null);

  const throttled = (label: (t: number) => string, set: (s: string) => void) => {
    let last = 0;
    return (t: number) => {
      const now = performance.now();
      if (now - last > 120) {
        last = now;
        set(label(t));
      }
    };
  };

  const runBench = async () => {
    if (boot.state !== "ready") return;
    setError(null);
    setSummary(null);
    setOutcomes([]);
    const results: CallOutcome[] = [];
    try {
      for (const [i, call] of boot.bundle.corpus.fixtures.entries()) {
        const run = await runSimulatedCall(call, boot.worker, boot.bundle, {
          onProgress: throttled((t) => `Running ${i + 1}/${fixtures.length}: ${call.title} · call time ${clock(t)}`, setProgress),
        });
        results.push(outcomeFor(call, run));
        setOutcomes([...results]);
      }
      const s = summarizeBench(results);
      setSummary(s);
      (window as unknown as { __kavachBench: unknown }).__kavachBench = { summary: s, outcomes: results.map(({ samples: _samples, ...o }) => o) };
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  };

  const runAB = async () => {
    if (boot.state !== "ready") return;
    const call = boot.bundle.corpus.fixtures.find((f) => f.id === abFixture);
    if (!call) return;
    setError(null);
    setAb(null);
    try {
      // Warm the runtime so neither arm pays first-query costs.
      for (const text of ["warming up the retrieval runtime", "second warm-up query for the embedder"]) {
        await boot.worker.query(boot.bundle.manifest.indexes.playbooks.name, text, { topK: 5, alpha: 1 });
      }
      const runA = await runSimulatedCall(call, boot.worker, boot.bundle, { onProgress: throttled((t) => `Arm A · Moss on-device · call time ${clock(t)}`, setAbProgress) });
      const hosted = new SimulatedHostedRetriever(boot.worker, profile, 42, false);
      const runB = await runSimulatedCall(call, hosted, boot.bundle, { onProgress: throttled((t) => `Arm B · hosted DB (simulated network) · call time ${clock(t)}`, setAbProgress) });
      setAb({ call, a: armFrom("Moss on-device", call, runA), b: armFrom(`Hosted vector DB · ${profile.medianRttMs} ms median RTT`, call, runB), profile });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAbProgress(null);
    }
  };

  const delta = ab && ab.a.outcome.warningAt !== null && ab.b.outcome.warningAt !== null ? ab.b.outcome.warningAt - ab.a.outcome.warningAt : null;

  return (
    <div className="min-h-screen">
      <SiteNav active="/bench">
        {ready && (
          <div className="flex flex-wrap gap-1.5">
            <Chip tone={boot.worker.info.crossOriginIsolated ? "ok" : "warn"}>{boot.worker.info.crossOriginIsolated ? "isolated" : "not isolated"}</Chip>
            <Chip>ORT ×{boot.worker.info.ortNumThreads ?? 1}</Chip>
            <Chip>corpus {boot.bundle.corpus.version}</Chip>
          </div>
        )}
      </SiteNav>

      <main className="mx-auto flex max-w-[1400px] flex-col gap-5 px-4 py-5">
        {boot.state === "loading" && <p className="text-[13px] text-muted">{boot.step}…</p>}
        {boot.state === "error" && <p className="text-[13px] text-danger">On-device retrieval could not start: {boot.message}</p>}
        {error && <p className="text-[13px] text-danger">{error}</p>}

        <section id="ab" className="rounded-[18px] border border-accent/30 bg-panel p-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">Latency A/B</div>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">Same call. Same pipeline. Where does retrieval run?</h1>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">
                Both arms replay the same transcript with the same thresholds, the same Moss index and the same on-device embedding, all executed live in this browser. Arm B adds a
                sampled network round trip to every retrieval, as a hosted vector database would. In simulated call time a slower result delays the next window, exactly as a serialized
                client would experience it.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select className={select} value={abFixture} onChange={(e) => setAbFixture(e.target.value)} disabled={!ready}>
                {fixtures
                  .filter((f) => f.label === "scam")
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.title}
                    </option>
                  ))}
              </select>
              <select className={select} value={profile.id} onChange={(e) => setProfile(NETWORK_PROFILES.find((p) => p.id === e.target.value) ?? { ...profile, id: "custom" })} disabled={!ready}>
                {NETWORK_PROFILES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} · {p.medianRttMs} ms
                  </option>
                ))}
                {profile.id === "custom" && <option value="custom">Custom · {profile.medianRttMs} ms</option>}
              </select>
              <label className="flex items-center gap-2 text-[12px] text-muted">
                RTT
                <input
                  type="range"
                  min={20}
                  max={800}
                  step={10}
                  value={profile.medianRttMs}
                  onChange={(e) => setProfile({ ...profile, id: "custom", label: "Custom", medianRttMs: Number(e.target.value) })}
                  disabled={!ready}
                />
                <span className="tabular w-14 font-mono text-fg">{profile.medianRttMs} ms</span>
              </label>
              <button className={button} type="button" onClick={runAB} disabled={!ready || Boolean(abProgress) || Boolean(progress)}>
                {abProgress ? "Running A/B…" : "Run A/B"}
              </button>
            </div>
          </div>
          {abProgress && <p className="mt-3 font-mono text-[12px] text-muted">{abProgress}</p>}

          {ab && (
            <div className="mt-5">
              <div className="mb-4 text-[15px] text-fg">
                {delta === null ? (
                  <span>{ab.a.outcome.warningAt === null ? "The on-device arm did not warn on this call." : "The hosted arm did not warn on this call."}</span>
                ) : (
                  <span>
                    Time to first warning: on-device <strong className="text-shield">{ab.a.outcome.warningAt!.toFixed(2)} s</strong> vs hosted{" "}
                    <strong className="text-warn">{ab.b.outcome.warningAt!.toFixed(2)} s</strong>
                    <span className="text-muted"> · {delta >= 0 ? `${delta.toFixed(2)} s earlier on-device` : `${(-delta).toFixed(2)} s later on-device`}</span>
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {[ab.a, ab.b].map((arm, i) => {
                  const o = arm.outcome;
                  return (
                    <div key={arm.label} className={`rounded-xl border p-4 ${i === 0 ? "border-shield/40" : "border-warn/40"}`}>
                      <div className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${i === 0 ? "text-shield" : "text-warn"}`}>
                        Arm {i === 0 ? "A" : "B"} · {arm.label}
                      </div>
                      <div className="mt-2 flex items-baseline gap-2">
                        <span className="tabular font-mono text-4xl font-semibold text-fg">{o.warningAt === null ? "—" : o.warningAt.toFixed(2)}</span>
                        <span className="text-sm text-muted">s time to first warning</span>
                      </div>
                      <p className="mt-1 text-[13px] text-muted">
                        {o.leadSeconds === null
                          ? "No warning before the call ended."
                          : o.leadSeconds >= 0
                            ? `${o.leadSeconds.toFixed(2)} s before the caller asks for the money or code`
                            : `${(-o.leadSeconds).toFixed(2)} s after the extraction began`}
                      </p>
                      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <Stat label="round trip p50" value={fmtMs(arm.roundTrip.p50)} unit="ms" />
                        <Stat label="round trip p99" value={fmtMs(arm.roundTrip.p99)} unit="ms" />
                        <Stat label="network p50" value={fmtMs(arm.network.p50)} unit="ms" hint="Simulated; zero for on-device" />
                        <Stat label="queries" value={o.queries} />
                      </div>
                      <div className="mt-3">
                        <CallTimeline call={ab.call} warningAt={o.warningAt} results={arm.results} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-[12px] text-faint">
                Measured on this device: embedding, Moss search, cosine re-scoring and worker round trip. Simulated: arm B&apos;s network delay only (log-normal, median {ab.profile.medianRttMs} ms, σ{" "}
                {ab.profile.sigma}, seed 42). Local embedding in arm B is conservative in the hosted arm&apos;s favour.
              </p>
            </div>
          )}
        </section>

        <Panel
          title="Replay eval bench · 10 labelled fixture calls"
          right={
            <button className={button} type="button" onClick={runBench} disabled={!ready || Boolean(progress) || Boolean(abProgress)}>
              {progress ? "Running…" : "Run eval bench"}
            </button>
          }
        >
          <p className="mb-3 text-[13px] text-muted">
            Every call runs through the full pipeline with live retrieval. A scam call counts as detected only when the warning renders before the caller&apos;s extraction turn and names an
            acceptable family. Thresholds were calibrated on a separate probe set; these fixtures were held out.
          </p>
          {progress && <p className="mb-3 font-mono text-[12px] text-muted">{progress}</p>}

          {summary && (
            <div className="mb-4 grid grid-cols-2 gap-3 rounded-xl border border-line bg-panel-2 p-4 sm:grid-cols-4 lg:grid-cols-8">
              <Stat label="Precision" value={pct(summary.precision)} />
              <Stat label="Recall" value={pct(summary.recall)} />
              <Stat label="F1" value={summary.f1.toFixed(3)} />
              <Stat label="TP / FP / FN / TN" value={`${summary.tp} / ${summary.fp} / ${summary.fn} / ${summary.tn}`} />
              <Stat label="Mean lead" value={summary.meanLeadSeconds === null ? "–" : summary.meanLeadSeconds.toFixed(1)} unit="s" hint="Seconds between the warning and the extraction turn" />
              <Stat label="Family acc." value={pct(summary.familyAccuracy)} />
              <Stat label="Stage recall" value={pct(summary.stageRecall)} />
              <Stat label="Claim verdicts" value={pct(summary.claimAccuracy)} hint={`Aligned ${pct(summary.claimAlignment)} of annotated claims`} />
              <Stat label="Moss search p50" value={fmtMs(summary.latency.searchMs.p50)} unit="ms" />
              <Stat label="search p99" value={fmtMs(summary.latency.searchMs.p99)} unit="ms" />
              <Stat label="search p99.9" value={fmtMs(summary.latency.searchMs.p999)} unit="ms" />
              <Stat label="embed p50" value={fmtMs(summary.latency.embedMs.p50)} unit="ms" />
              <Stat label="embed p99" value={fmtMs(summary.latency.embedMs.p99)} unit="ms" />
              <Stat label="round trip p50" value={fmtMs(summary.latency.roundTripMs.p50)} unit="ms" />
              <Stat label="round trip p99.9" value={fmtMs(summary.latency.roundTripMs.p999)} unit="ms" />
              <Stat label="retrievals" value={summary.latency.roundTripMs.n} />
            </div>
          )}

          {outcomes.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-[12.5px]">
                <thead className="text-[10.5px] uppercase tracking-[0.12em] text-faint">
                  <tr className="border-b border-line">
                    <th className="py-2 pr-3">Call</th>
                    <th className="py-2 pr-3">Label</th>
                    <th className="py-2 pr-3">Result</th>
                    <th className="py-2 pr-3">Warning</th>
                    <th className="py-2 pr-3">Extraction</th>
                    <th className="py-2 pr-3">Lead</th>
                    <th className="py-2 pr-3">Detected family</th>
                    <th className="py-2 pr-3">Stages reached</th>
                    <th className="py-2 pr-3">Claims</th>
                    <th className="py-2">Queries</th>
                  </tr>
                </thead>
                <tbody>
                  {outcomes.map((o) => {
                    const v = verdictOf(o);
                    return (
                      <tr key={o.fixtureId} className="border-b border-line/60 align-top">
                        <td className="py-2 pr-3 text-fg">{o.title}</td>
                        <td className="py-2 pr-3 text-muted">{o.label === "scam" ? FAMILY_LABELS[o.family!] : "benign"}</td>
                        <td className="py-2 pr-3">
                          <Chip tone={v.tone}>{v.label}</Chip>
                        </td>
                        <td className="tabular py-2 pr-3 font-mono">{o.warningAt === null ? "–" : `${o.warningAt.toFixed(1)}s`}</td>
                        <td className="tabular py-2 pr-3 font-mono text-muted">{o.extractionAt === null ? "–" : `${o.extractionAt.toFixed(1)}s`}</td>
                        <td className="tabular py-2 pr-3 font-mono">{o.leadSeconds === null ? "–" : `${o.leadSeconds.toFixed(1)}s`}</td>
                        <td className="py-2 pr-3 text-muted">{o.warnedFamily ? FAMILY_LABELS[o.warnedFamily] : "–"}</td>
                        <td className="py-2 pr-3 text-muted">
                          {o.label === "scam" ? `${o.stages.annotated.filter((s) => o.stages.reached.includes(s)).length}/${o.stages.annotated.length}` : "–"}
                          <div className="text-[11px] text-faint">{o.stages.reached.map((s) => STAGE_LABELS[s]).join(" → ")}</div>
                        </td>
                        <td className="tabular py-2 pr-3 font-mono text-muted">{o.claims.annotated ? `${o.claims.correct}/${o.claims.annotated}` : "–"}</td>
                        <td className="tabular py-2 font-mono text-muted">{o.queries}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </main>
    </div>
  );
}
