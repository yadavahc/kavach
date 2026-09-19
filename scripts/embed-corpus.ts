/**
 * Embeds every indexed document with the in-browser model (the same ONNX
 * embedder that embeds live queries) and writes corpus/dist/doc-embeddings.json.
 * The client re-scores Moss's top-k hits against these vectors, because
 * moss-web returns rank-derived scores that cannot be thresholded.
 *
 *   npm run corpus:embed
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { groundTruthToDoc, playbookToDoc, type CorpusManifest } from "../corpus/docs";
import { CorpusError, loadCorpus } from "../corpus/load";
import { cosine, encodeVectors, type DocEmbeddingsFile } from "../lib/detection/vectors";
import type { MossModelId } from "../lib/moss/runtime";
import { openBrowserSession, VENDOR_URLS } from "./lib/browser-session";
import { c, DIST_DIR, fmtMs, loadEnv, mossCredentials, section, table } from "./lib/cli";

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

section("Embed corpus in browser runtime");
const session = await openBrowserSession({ entry: "scripts/browser/harness.ts", isolated: true });
try {
  const { page } = session;
  const info = await page.evaluate((cfg) => window.__kavach.init(cfg), {
    ...creds,
    model: manifest.model as MossModelId,
    indexes: [],
    wasmUrl: VENDOR_URLS.mossWasm,
    onnxWasmPath: VENDOR_URLS.ortDir,
  });
  console.log(c.dim(`  runtime ready in ${fmtMs(info.initMs)} ms (ORT threads ${info.ortNumThreads})`));

  const sets = {
    playbooks: corpus.playbooks.map(playbookToDoc),
    ground_truth: corpus.groundTruth.map(groundTruthToDoc),
  };
  const encoded = {} as DocEmbeddingsFile["indexes"];
  const rows: (string | number)[][] = [];
  let dim = 0;
  for (const [kind, docs] of Object.entries(sets) as [keyof typeof sets, typeof sets.playbooks][]) {
    const t0 = performance.now();
    const vecs = await page.evaluate((texts) => window.__kavach.embedMany(texts), docs.map((d) => d.text));
    const ms = performance.now() - t0;
    dim = vecs[0]?.length ?? 0;
    const norms = vecs.map((v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)));
    // Determinism check: re-embedding a sample must reproduce the stored vectors exactly.
    const sample = [0, Math.floor(docs.length / 2), docs.length - 1];
    const again = await page.evaluate((texts) => window.__kavach.embedMany(texts), sample.map((i) => docs[i]!.text));
    const minSelf = Math.min(...sample.map((i, j) => cosine(vecs[i]!, again[j]!)));
    if (minSelf < 0.999999) throw new Error(`${kind}: re-embedding is not reproducible (min self-cosine ${minSelf})`);
    encoded[kind] = encodeVectors(docs.map((d) => d.id), vecs);
    rows.push([kind, docs.length, dim, `${Math.min(...norms).toFixed(4)}–${Math.max(...norms).toFixed(4)}`, minSelf.toFixed(6), fmtMs(ms / docs.length)]);
  }
  console.log(table(["index", "docs", "dim", "L2 norm range", "min self-cosine", "ms/doc"], rows));

  const file: DocEmbeddingsFile = {
    model: manifest.model,
    dim,
    corpusVersion: `${manifest.indexes.playbooks.hash}.${manifest.indexes.ground_truth.hash}`,
    generatedAt: new Date().toISOString(),
    indexes: encoded,
  };
  const out = join(DIST_DIR, "doc-embeddings.json");
  writeFileSync(out, JSON.stringify(file) + "\n");
  console.log(c.green(`\n✓ wrote corpus/dist/doc-embeddings.json (${(readFileSync(out).length / 1024).toFixed(0)} KB, corpus ${file.corpusVersion})`));
} catch (err) {
  console.error(c.red(`\n✗ embed failed: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
} finally {
  await session.close();
}
