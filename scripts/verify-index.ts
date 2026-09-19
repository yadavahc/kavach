/**
 * Query verification against the published indexes via the NODE runtime
 * (@moss-dev/moss, native core). The Node SDK embeds and searches in one call
 * and does not expose the query embedding, so only Moss rank metrics and total
 * latency are available here; calibrated decisions are verified in the browser
 * runtime the app ships (scripts/verify-browser.ts).
 *
 *   npm run index:verify
 *   npx tsx scripts/verify-index.ts --alpha '1,0.8' --latency-iters 5000
 */
import { cpus, platform } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MossClient } from "@moss-dev/moss";
import type { CorpusManifest } from "../corpus/docs";
import { CorpusError, loadCorpus } from "../corpus/load";
import { DETECTION } from "../lib/detection/config";
import { c, DIST_DIR, fmtMs, loadEnv, mossCredentials, section } from "./lib/cli";
import { evaluate, type Hit } from "./lib/evaluate";

const { values: args } = parseArgs({
  options: {
    alpha: { type: "string", default: String(DETECTION.alpha) },
    "top-k": { type: "string", default: String(DETECTION.topK) },
    "latency-iters": { type: "string", default: "2000" },
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

const { projectId, projectKey } = mossCredentials();
const client = new MossClient(projectId, projectKey);
const toHits = (docs: Hit[]): Hit[] => docs.map((d) => ({ id: d.id, score: d.score }));

try {
  section("Load (Node native runtime)");
  for (const name of [manifest.indexes.playbooks.name, manifest.indexes.ground_truth.name]) {
    const info = await client.getIndex(name);
    const t0 = performance.now();
    await client.loadIndex(name);
    console.log(`  ${name}: ${info.docCount} docs, model ${info.model?.id ?? "?"}, loadIndex ${fmtMs(performance.now() - t0)} ms`);
  }

  const result = await evaluate(
    {
      label: "node",
      queryBatch: async (index, texts, opts) => {
        const out: Hit[][] = [];
        for (const text of texts) out.push(toHits((await client.query(index, text, opts)).docs));
        return out;
      },
      bench: async (index, texts, iters, opts) => {
        for (let i = 0; i < 30; i++) await client.query(index, texts[i % texts.length]!, opts); // warm-up, discarded
        const totalMs: number[] = [];
        for (let i = 0; i < iters; i++) {
          const t0 = performance.now();
          await client.query(index, texts[i % texts.length]!, opts);
          totalMs.push(performance.now() - t0);
        }
        return { totalMs, embedMs: [], searchMs: [], rescoreMs: [] };
      },
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

  writeFileSync(
    join(DIST_DIR, "verify-report.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runtime: { kind: "node", sdk: "@moss-dev/moss", node: process.version, platform: platform(), cpu: cpus()[0]?.model ?? "unknown" },
        model: manifest.model,
        indexes: { playbooks: manifest.indexes.playbooks.name, ground_truth: manifest.indexes.ground_truth.name },
        topK: Number(args["top-k"]),
        alphas: result.alphas,
        latency: result.latency,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(c.dim("\n  wrote corpus/dist/verify-report.json"));
} catch (err) {
  console.error(c.red(`\n✗ verify failed: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
} finally {
  await client.close();
}
