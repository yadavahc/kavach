/**
 * Query-correctness + latency verification through the BROWSER runtime the app
 * ships (@moss-dev/moss-web: WASM index, ONNX query embedding), driven from the
 * CLI in headless Chrome/Edge.
 *
 *   npm run index:verify:browser
 *   npx tsx scripts/verify-browser.ts --alpha '1,0.8,0.5' --latency-iters 5000
 *   npx tsx scripts/verify-browser.ts --diagnose [--ort-threads 1]   # determinism diagnosis only
 *   npx tsx scripts/verify-browser.ts --isolation off     # measure without cross-origin isolation
 *   npx tsx scripts/verify-browser.ts --browser "C:\path\to\chrome.exe" --headed
 *
 * The page is served cross-origin isolated by default (COOP same-origin, COEP
 * credentialless), which is what the app ships: it gives 5µs timer resolution
 * instead of 100µs and lets ONNX Runtime use threads.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import type { CorpusManifest } from "../corpus/docs";
import { CorpusError, loadCorpus } from "../corpus/load";
import { DETECTION } from "../lib/detection/config";
import type { DocEmbeddingsFile, EncodedVectors } from "../lib/detection/vectors";
import type { MossModelId } from "../lib/moss/runtime";
import type { HarnessHit } from "./browser/harness";
import { openBrowserSession, VENDOR_URLS } from "./lib/browser-session";
import { c, DIST_DIR, fmtMs, loadEnv, mossCredentials, ROOT, section, table } from "./lib/cli";
import { checkGates, evaluate } from "./lib/evaluate";

const { values: args } = parseArgs({
  options: {
    alpha: { type: "string", default: String(DETECTION.alpha) },
    "top-k": { type: "string", default: String(DETECTION.topK) },
    "latency-iters": { type: "string", default: "2000" },
    "min-family-acc": { type: "string", default: "0.8" },
    "min-claim-acc": { type: "string", default: "0.75" },
    isolation: { type: "string", default: "on" },
    "ort-threads": { type: "string" },
    diagnose: { type: "boolean", default: false },
    browser: { type: "string" },
    headed: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
  },
});

loadEnv();
const manifestPath = join(DIST_DIR, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(c.red("corpus/dist/manifest.json not found. Run `npm run index:build` first."));
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CorpusManifest;
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
const isolated = args.isolation !== "off";
const indexes = [manifest.indexes.playbooks.name, manifest.indexes.ground_truth.name];
const PARITY_TEXTS = ["please read me the code that just arrived", "your parcel was seized by customs", "hi mom, I landed safely"];

// Document embeddings enable calibrated (cosine) decisions; without them only rank metrics are reported.
let docVectors: Record<string, EncodedVectors> | undefined;
const embeddingsPath = join(DIST_DIR, "doc-embeddings.json");
const corpusVersion = `${manifest.indexes.playbooks.hash}.${manifest.indexes.ground_truth.hash}`;
if (existsSync(embeddingsPath)) {
  const emb = JSON.parse(readFileSync(embeddingsPath, "utf8")) as DocEmbeddingsFile;
  if (emb.corpusVersion !== corpusVersion || emb.model !== manifest.model) {
    console.error(c.red(`doc-embeddings.json is for corpus ${emb.corpusVersion} / ${emb.model}, manifest is ${corpusVersion} / ${manifest.model}. Run npm run corpus:embed.`));
    process.exit(2);
  }
  docVectors = { [manifest.indexes.playbooks.name]: emb.indexes.playbooks, [manifest.indexes.ground_truth.name]: emb.indexes.ground_truth };
} else {
  console.log(c.yellow("corpus/dist/doc-embeddings.json not found: run npm run corpus:embed for calibrated metrics."));
}

const fmtHits = (hits: HarnessHit[]) => hits.map((h) => `${h.id} ${h.score.toFixed(6)}`).join("  ");
const exp = (n: number) => (n === 0 ? "0" : n.toExponential(1));
const rel = (path: string) => path.slice(ROOT.length + 1).replaceAll("\\", "/");

section("Browser session");
const session = await openBrowserSession({ entry: "scripts/browser/harness.ts", isolated, browserPath: args.browser, headed: args.headed, verbose: args.verbose });

try {
  const { page } = session;
  section(`Init (${basename(session.executablePath)}, isolation ${isolated ? "on" : "off"})`);
  const init = await page.evaluate((cfg) => window.__kavach.init(cfg), {
    ...creds,
    model: manifest.model as MossModelId,
    indexes,
    wasmUrl: VENDOR_URLS.mossWasm,
    onnxWasmPath: VENDOR_URLS.ortDir,
    ortThreads: args["ort-threads"] ? Number(args["ort-threads"]) : undefined,
    docVectors,
  });
  console.log(
    table(
      ["property", "value"],
      [
        ["user agent", init.userAgent.replace(/^Mozilla\/5\.0 /, "")],
        ["crossOriginIsolated", String(init.crossOriginIsolated)],
        ["hardwareConcurrency / ORT threads", `${init.hardwareConcurrency} / ${init.ortNumThreads ?? "default"}`],
        ["performance.now() resolution", `${(init.timerResolutionMs * 1000).toFixed(1)} µs`],
        ["SDK init (WASM + tokenizer + ONNX model)", `${fmtMs(init.initMs)} ms`],
        ...Object.entries(init.loadIndexMs).map(([name, ms]) => [`loadIndex ${name}`, `${fmtMs(ms)} ms`]),
        ["document embeddings", docVectors ? `loaded (corpus ${corpusVersion})` : "not loaded"],
      ],
    ),
  );

  if (args.diagnose) {
    section(`Determinism diagnosis (ORT threads ${init.ortNumThreads ?? "default"}, 5 repeats)`);
    const texts = [...PARITY_TEXTS, ...corpus.probes.playbook.slice(0, 3).map((p) => p.text)];
    const rows = await page.evaluate((i, t, r) => window.__kavach.diagnose(i, t, r), indexes, texts, 5);
    console.log(
      table(
        ["index", "text", "embed Δ", "α=1 search / query Δ", "α=0.8 search / query Δ", "α=0 search / query Δ"],
        rows.map((r) => [
          r.index.replace(/^kavach-|-[0-9a-f]{10}$/g, ""),
          r.text.length > 34 ? `${r.text.slice(0, 33)}…` : r.text,
          exp(r.embedMaxDelta),
          ...["1", "0.8", "0"].map((a) => {
            const x = r.alphas[a]!;
            return `${exp(x.searchMaxDelta)}${x.searchOrderStable ? "" : "*"} / ${exp(x.queryMaxDelta)}${x.queryOrderStable ? "" : "*"}`;
          }),
        ]),
      ),
    );
    console.log(c.dim("  Δ = max per-id score difference across repeats; * = result order changed between repeats"));
    for (const r of rows.filter((_, i) => i % texts.length === 0)) {
      console.log(c.dim(`\n  score scale on ${r.index} "${r.text}":`));
      for (const a of ["1", "0.8", "0"]) console.log(c.dim(`    α=${a}: ${fmtHits(r.alphas[a]!.first)}`));
    }
    const out = join(DIST_DIR, `diagnose-browser.threads-${init.ortNumThreads ?? "default"}.json`);
    writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), init, rows }, null, 2) + "\n");
    console.log(c.dim(`\n  wrote ${rel(out)}`));
  } else {
    section("Parity (split embed+search path vs query(), alpha 1)");
    const parity = await page.evaluate((i, t) => window.__kavach.parity(i, t), indexes, PARITY_TEXTS);
    console.log(
      `  ${parity.mismatches.length ? c.red(`${parity.mismatches.length}/${parity.checked} differ`) : c.green(`${parity.checked}/${parity.checked} identical`)}` +
        ` (ε=${parity.epsilon}, max score delta ${exp(parity.maxScoreDelta)})`,
    );
    if (parity.mismatches.length) {
      for (const m of parity.mismatches) {
        console.log(c.yellow(`\n  ${m.kind} on ${m.index} "${m.text}": ${m.note}`));
        console.log(`    a: ${fmtHits(m.a)}`);
        console.log(`    b: ${fmtHits(m.b)}`);
      }
      const splitOnly = parity.mismatches.some((m) => m.kind === "split-vs-query") && !parity.mismatches.some((m) => m.kind === "query-vs-query");
      throw new Error(
        splitOnly
          ? "timed split path diverges from query() while query() is self-consistent"
          : "query() is not self-consistent in this runtime; split-path parity cannot be asserted (run with --diagnose)",
      );
    }

    const result = await evaluate(
      {
        label: "browser",
        queryBatch: (index, texts, opts) => page.evaluate((i, t, o) => window.__kavach.queryBatch(i, t, o), index, texts, opts),
        bench: (index, texts, iters, opts) => page.evaluate((i, t, n, o) => window.__kavach.bench(i, t, n, o), index, texts, iters, opts),
      },
      corpus,
      manifest,
      {
        alphas: args.alpha.split(",").map(Number),
        topK: Number(args["top-k"]),
        latencyIters: Number(args["latency-iters"]),
        verbose: args.verbose,
        detection: DETECTION,
      },
    );

    const reportPath = join(DIST_DIR, `verify-browser-report${isolated ? "" : ".no-isolation"}.json`);
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          runtime: { kind: "browser", sdk: "@moss-dev/moss-web", browser: basename(session.executablePath), isolation: isolated, ...init },
          model: manifest.model,
          indexes: { playbooks: manifest.indexes.playbooks.name, ground_truth: manifest.indexes.ground_truth.name },
          corpusVersion,
          topK: Number(args["top-k"]),
          detection: DETECTION,
          parity,
          alphas: result.alphas,
          latency: result.latency,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(c.dim(`\n  wrote ${rel(reportPath)}`));

    const ok = checkGates(result.gate, { familyAccuracy: Number(args["min-family-acc"]), claimAccuracy: Number(args["min-claim-acc"]) });
    if (!ok) process.exitCode = 1;
  }
} catch (err) {
  console.error(c.red(`\n✗ browser verify failed: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
} finally {
  await session.close();
}
