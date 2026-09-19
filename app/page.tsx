import Link from "next/link";
import evalReport from "@/corpus/dist/eval-report.json";
import manifest from "@/corpus/dist/manifest.json";
import { ArchitectureDiagram, type ArchEdge, type ArchNode } from "@/components/landing/ArchitectureDiagram";
import { DemoTimeline } from "@/components/landing/DemoTimeline";
import { Hero3D } from "@/components/landing/Hero3D";
import { ShieldMark, SiteNav } from "@/components/SiteNav";
import { fmtMs } from "@/components/ui";
import { DETECTION } from "@/lib/detection/config";

// Every number on this page is read from corpus/dist/eval-report.json, written by
// `npm run eval` (held-out fixture calls, retrieval in headless Chrome).
const lat = evalReport.retrievalLatency;
const sum = evalReport.summary;
const measuredOn = new Date(evalReport.generatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const browser = evalReport.runtime.userAgent.match(/(?:Headless)?Chrome\/\d+/)?.[0]?.replace("Headless", "Headless ") ?? "Chrome";
const pct = (x: number) => `${Math.round(x * 100)}%`;

type AbRow = (typeof evalReport.latencyAB)[number];
const profiles = [...new Set(evalReport.latencyAB.map((r) => r.profile))].map((id) => {
  const rows = evalReport.latencyAB.filter((r: AbRow) => r.profile === id);
  const deltas = rows.flatMap((r) => (typeof r.ttfwDeltaSeconds === "number" ? [r.ttfwDeltaSeconds] : []));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  return {
    id,
    rtt: rows[0]!.medianRttMs,
    meanDelta: mean(deltas),
    maxDelta: Math.max(...deltas),
    onDeviceAge: mean(rows.map((r) => r.onDevice.roundTripMs.p50)),
    hostedAge: mean(rows.map((r) => r.hosted.roundTripMs.p50)),
    onDeviceQueries: mean(rows.map((r) => r.onDevice.queries)),
    hostedQueries: mean(rows.map((r) => r.hosted.queries)),
  };
});
const PROFILE_LABEL: Record<string, string> = { "same-region": "Same-region cloud", "cross-region": "Cross-region cloud", mobile: "Mobile network" };

const loadMs = Object.values(evalReport.runtime.loadIndexMs as Record<string, number>);

const nodes: ArchNode[] = [
  { id: "mic", label: "Microphone", where: "device", x: 22, y: 50, w: 118, metric: null, metricNote: "Call audio is captured and processed in the browser tab. It is never uploaded by Kavach.", detail: "Speakerphone call audio or a fixture transcript when no microphone is available." },
  { id: "stt", label: "Speech-to-text", where: "device", x: 162, y: 50, w: 140, metric: null, metricNote: "Not measured here: Web Speech API, on-device where Chrome offers it, labelled in the app otherwise.", detail: "Streaming recognition with interim results; words are time-stamped as they arrive." },
  { id: "window", label: `Rolling window · ${DETECTION.windowSeconds} s`, where: "device", x: 324, y: 50, w: 150, metric: `every ${DETECTION.tickMs} ms`, metricNote: "Retrieval cadence: one query per tick while speech is arriving.", detail: "The last few seconds of speech, re-queried as it slides, at most one query in flight." },
  { id: "embed", label: "ONNX query embedding", where: "device", x: 496, y: 50, w: 168, metric: `p50 ${fmtMs(lat.embedMs.p50)} · p99 ${fmtMs(lat.embedMs.p99)} ms`, metricNote: "Measured in-browser (Web Worker, WASM, 4 threads) over the held-out fixture calls.", detail: "moss-minilm, the same model Moss built the index with, running through onnxruntime-web." },
  { id: "moss", label: "Moss search · playbooks", where: "device", x: 686, y: 50, w: 168, metric: `p50 ${fmtMs(lat.searchMs.p50)} · p99 ${fmtMs(lat.searchMs.p99)} ms`, metricNote: `@moss-dev/moss-web WASM index, loaded once per session (${loadMs.map((m) => `${Math.round(m)} ms`).join(" and ")} for the two indexes).`, detail: `${manifest.indexes.playbooks.docCount} scam and benign script fragments, versioned index ${manifest.indexes.playbooks.name}.` },
  { id: "decide", label: "Re-score + decision", where: "device", x: 686, y: 150, w: 168, metric: `re-score p50 ${fmtMs(lat.rescoreMs.p50)} ms`, metricNote: `Cosine re-scoring of Moss's top ${DETECTION.topK}, then the calibrated rule: same-family streak ≥ ${DETECTION.warnMinSpanSeconds} s across ${DETECTION.minDistinctStages} script stages.`, detail: "Watch state on a single stage, warning once the script progresses. Benign contrast entries compete in the same index." },
  { id: "warn", label: "Warning + counter-line", where: "device", x: 496, y: 150, w: 168, metric: null, metricNote: "Pre-written line per family and stage renders with the warning, no network call.", detail: "A calm sentence the person can say, plus what to do next." },
  { id: "claims", label: "Claim check · ground truth", where: "device", x: 324, y: 150, w: 150, metric: `p50 ${fmtMs(lat.totalMs.p50)} ms per claim`, metricNote: "Same embed + Moss search path against the ground-truth index, when an utterance ends.", detail: `${manifest.indexes.ground_truth.docCount} published counter-facts with sources; verdicts are contradicted, consistent or unverifiable.` },
  { id: "evidence", label: "Pressure + evidence", where: "device", x: 22, y: 150, w: 280, metric: null, metricNote: "Built on the device: JSON and printable PDF with a SHA-256 digest.", detail: "Coercion pressure curve, stage timeline, matched patterns, claims and transcript for a cybercrime complaint." },
  { id: "corpus", label: "Corpus + checks", where: "server", x: 22, y: 318, w: 160, metric: null, metricNote: "Build time: schema validation, coverage, leakage and source checks.", detail: "Playbooks, ground truth, dev calls and held-out fixtures, kept disjoint." },
  { id: "build", label: "Moss Cloud index build", where: "server", x: 206, y: 318, w: 190, metric: null, metricNote: "Build time: content-addressed index names; a published index never changes under a client.", detail: "npm run index:build writes the manifest the app follows." },
  { id: "llm", label: "Counter-line variants (LLM)", where: "server", x: 420, y: 318, w: 210, metric: null, metricNote: "Optional server action; only the family and stage are sent, never the transcript.", detail: "An LLM (Gemini by default) generates alternative phrasings on request. Not on the detection path." },
  { id: "config", label: "Moss credentials", where: "server", x: 654, y: 318, w: 200, metric: null, metricNote: "Read from server env at request time so the key can rotate without a rebuild.", detail: "The browser SDK still sees the key: use a project that holds only public-corpus indexes." },
];

const edges: ArchEdge[] = [
  { from: "mic", to: "stt" },
  { from: "stt", to: "window" },
  { from: "window", to: "embed" },
  { from: "embed", to: "moss" },
  { from: "moss", to: "decide" },
  { from: "decide", to: "warn" },
  { from: "stt", to: "claims" },
  { from: "claims", to: "evidence" },
  { from: "warn", to: "evidence" },
  { from: "corpus", to: "build", dashed: true },
  { from: "build", to: "moss", dashed: true },
  { from: "llm", to: "warn", dashed: true },
];

const FEATURES = [
  ["Script retrieval", "The rolling transcript is matched against scam playbooks every 300 ms, showing the pattern, its similarity and the stage of the script."],
  ["Atomic claim check", "Caller assertions are split out and checked against published guidance: contradicted, consistent or unverifiable, with the source."],
  ["Voice Circle", "Trusted contacts and a household passphrase. When a call follows an impersonation script, it walks you through verifying outside the call."],
  ["Counter-line", "A calm sentence you can say, pre-written per family and stage so it appears the instant a warning fires."],
  ["Coercion pressure meter", "Urgency, isolation, secrecy and authority, plotted across the call."],
  ["Evidence pack", "Timestamped transcript, matched patterns, verdicts and the pressure curve as JSON and a printable PDF, built on your device."],
  ["Replay eval bench", "Labelled scam and benign calls through the real pipeline: precision, recall, F1 and retrieval p50/p99/p99.9."],
  ["Latency A/B", "The same call through on-device Moss and a simulated hosted vector DB, with time to first warning side by side."],
];

export default function Home() {
  return (
    <div className="min-h-screen">
      <SiteNav />

      <section className="relative isolate overflow-hidden border-b border-line">
        <Hero3D />
        <div className="relative mx-auto flex min-h-[78vh] max-w-[1200px] flex-col justify-center px-4 py-20">
          <div className="mb-5 flex items-center gap-2 text-[12px] uppercase tracking-[0.2em] text-shield">
            <ShieldMark className="h-4 w-4" />
            Kavach Live
          </div>
          <h1 className="max-w-3xl text-4xl font-semibold leading-[1.08] tracking-tight text-fg sm:text-6xl">
            Voices can be cloned.
            <br />
            <span className="text-shield">Scripts can&apos;t hide.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-muted">
            Kavach listens to a call on your device and matches what the caller says against the scripts scams actually run on: digital arrest, KYC expiry, OTP harvesting,
            fake tech support, cloned relatives. It warns while the script is still unfolding, before the money or the code leaves.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/live" className="rounded-lg bg-fg px-5 py-3 text-[15px] font-semibold text-ink hover:bg-shield">
              Try live
            </Link>
            <Link href="/bench" className="rounded-lg border border-line bg-panel/70 px-5 py-3 text-[15px] font-medium text-fg hover:border-accent">
              Run the eval bench
            </Link>
          </div>
          <dl className="mt-12 grid max-w-3xl grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4">
            {[
              ["Moss search p50", `${fmtMs(lat.searchMs.p50)} ms`],
              ["Per query, embed + search p50", `${fmtMs(lat.totalMs.p50)} ms`],
              ["Held-out recall / precision", `${pct(sum.recall)} / ${pct(sum.precision)}`],
              ["Mean warning lead", `${sum.meanLeadSeconds?.toFixed(0) ?? "–"} s`],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-[10.5px] uppercase tracking-[0.14em] text-faint">{k}</dt>
                <dd className="tabular mt-1 font-mono text-xl text-fg">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-[12px] text-faint">
            Measured {measuredOn} in {browser} on {sum.calls} held-out synthetic calls. Lead is time between the warning and the caller&apos;s request for money or a code.
          </p>
        </div>
      </section>

      <main className="mx-auto flex max-w-[1200px] flex-col gap-24 px-4 py-20">
        <section className="grid grid-cols-1 items-center gap-10 lg:grid-cols-[1fr_1.15fr]">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight text-fg">Watch one interception</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">
              A caller claiming to be the cyber cell works through the digital-arrest script: authority, then isolation. Kavach stays quiet on the opener, matches the script as it
              progresses, and puts a line on screen that ends the call on the victim&apos;s terms.
            </p>
            <p className="mt-3 text-[13px] text-faint">The animation is scripted. The live app runs the real pipeline on your device.</p>
          </div>
          <DemoTimeline />
        </section>

        <section className="grid grid-cols-1 gap-10 lg:grid-cols-2">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight text-fg">The voice is no longer evidence</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">
              A few seconds of someone&apos;s voice is enough to clone it, and detectors that listen for synthesis artifacts lose much of their accuracy outside the lab. Losses are
              concentrated among older adults and, in India, in the wave of &ldquo;digital arrest&rdquo; calls.
            </p>
          </div>
          <div>
            <h2 className="text-3xl font-semibold tracking-tight text-fg">The script is</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">
              An attacker can perfect the voice. They cannot skip the script, because the script is what extracts the money. Scam calls follow a small, stable set of coercion
              playbooks, and each one moves through the same stages:
            </p>
            <ol className="mt-4 grid grid-cols-5 gap-1.5 text-[12px]">
              {["Hook", "Authority", "Isolation", "Urgency", "Extraction"].map((s, i) => (
                <li key={s} className="rounded-md border border-line bg-panel px-2 py-2 text-center text-fg/90">
                  <div className="tabular font-mono text-[10px] text-faint">{i + 1}</div>
                  {s}
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section>
          <h2 className="text-3xl font-semibold tracking-tight text-fg">Why retrieval has to run on the device</h2>
          <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-muted">
            The transcript is re-queried every {DETECTION.tickMs} ms for the whole call. On-device Moss answers in {fmtMs(lat.searchMs.p50)} ms, so each result describes speech that is
            about {fmtMs(lat.totalMs.p50)} ms old. A hosted vector database adds a network round trip to every query: results describe older speech, fewer windows are examined, and the
            call audio has to leave the phone. We replayed the same held-out scam calls through both, with the hosted arm&apos;s network delay simulated and everything else measured.
          </p>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13.5px]">
              <thead className="text-[11px] uppercase tracking-[0.12em] text-faint">
                <tr className="border-b border-line">
                  <th className="py-2 pr-4">Hosted network (simulated)</th>
                  <th className="py-2 pr-4">Result age p50, on-device / hosted</th>
                  <th className="py-2 pr-4">Windows examined per call</th>
                  <th className="py-2 pr-4">Time to first warning, mean change</th>
                  <th className="py-2">Worst call</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => (
                  <tr key={p.id} className="border-b border-line/60">
                    <td className="py-2.5 pr-4 text-fg">
                      {PROFILE_LABEL[p.id] ?? p.id} · {p.rtt} ms RTT
                    </td>
                    <td className="tabular py-2.5 pr-4 font-mono">
                      {fmtMs(p.onDeviceAge)} / {fmtMs(p.hostedAge)} ms
                    </td>
                    <td className="tabular py-2.5 pr-4 font-mono">
                      {Math.round(p.onDeviceQueries)} / {Math.round(p.hostedQueries)}
                    </td>
                    <td className="tabular py-2.5 pr-4 font-mono">+{p.meanDelta.toFixed(2)} s</td>
                    <td className="tabular py-2.5 font-mono">+{p.maxDelta.toFixed(2)} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 max-w-3xl text-[13px] text-faint">
            Honest reading: because a warning needs {DETECTION.warnMinSpanSeconds} s of sustained evidence, network delay usually shifts it by well under a second; it costs seconds when
            sparser sampling breaks a streak. The larger costs are staleness, lost evidence and privacy. Run it yourself on the{" "}
            <Link href="/bench" className="text-accent hover:underline">
              bench
            </Link>
            .
          </p>
        </section>

        <section id="architecture" className="scroll-mt-20">
          <h2 className="text-3xl font-semibold tracking-tight text-fg">Architecture</h2>
          <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-muted">
            Everything on the detection path runs in the browser. The server builds and publishes the indexes, serves the Moss credentials and, optionally, phrases counter-lines.
          </p>
          <div className="mt-6">
            <ArchitectureDiagram nodes={nodes} edges={edges} source={`Latencies measured ${measuredOn}, ${browser}, held-out fixture calls.`} />
          </div>
        </section>

        <section>
          <h2 className="text-3xl font-semibold tracking-tight text-fg">What it does</h2>
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map(([title, body]) => (
              <div key={title} className="panel p-4">
                <h3 className="text-[14px] font-semibold text-fg">{title}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-[18px] border border-line bg-panel p-8 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-fg">Put a call through it</h2>
          <p className="mx-auto mt-2 max-w-xl text-[14.5px] text-muted">Play one of the labelled calls, or use your microphone on speakerphone. Nothing you say is uploaded by Kavach.</p>
          <Link href="/live" className="mt-5 inline-block rounded-lg bg-fg px-5 py-3 text-[15px] font-semibold text-ink hover:bg-shield">
            Try live
          </Link>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1200px] flex-wrap justify-between gap-4 px-4 py-8 text-[12px] text-faint">
          <span>Kavach Live · built for the YC × Moss Zero Latency Builder Sprint</span>
          <span>Synthetic calls only. Not a substitute for calling your bank or the police on a number you trust.</span>
        </div>
      </footer>
    </div>
  );
}
