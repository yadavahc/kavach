/**
 * Build + publish the two Moss indexes from the validated corpus.
 *
 *   npm run index:build                 # build what changed, reuse what didn't
 *   npm run index:plan                  # validate + print plan, no network
 *   npx tsx scripts/build-index.ts --force        # delete and rebuild even if the hash exists
 *   npx tsx scripts/build-index.ts --prune        # delete kavach-* indexes other than current + previous
 *   npx tsx scripts/build-index.ts --skip-smoke   # skip the Node local load + self-retrieval check
 *   npx tsx scripts/build-index.ts --model moss-mediumlm
 *
 * Index names are content-addressed (kavach-playbooks-<hash>), so a published
 * index never changes underneath a running client. Once Moss confirms both
 * indexes, the build writes corpus/dist/manifest.json (which index the app
 * loads) and corpus/dist/client-corpus.json (full records the client joins to
 * Moss hits by id). The smoke test runs after that, so a local-runtime problem
 * cannot leave a published corpus without a pointer.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MossClient } from "@moss-dev/moss";
import {
  contentHash,
  groundTruthToDoc,
  INDEX_PREFIX,
  indexName,
  playbookToDoc,
  type CorpusManifest,
  type IndexKind,
  type IndexManifestEntry,
  type MossDoc,
} from "../corpus/docs";
import { CorpusError, loadCorpus } from "../corpus/load";
import { SCHEMA_VERSION } from "../corpus/schema";
import { c, DIST_DIR, fmtMs, loadEnv, mossCredentials, resolveModel, section, table } from "./lib/cli";

const KINDS: IndexKind[] = ["playbooks", "ground_truth"];
const SMOKE_SAMPLES = 5;

const { values: args } = parseArgs({
  options: {
    model: { type: "string" },
    force: { type: "boolean", default: false },
    prune: { type: "boolean", default: false },
    "skip-smoke": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

loadEnv();
const model = resolveModel(args.model);

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

const plan = Object.fromEntries(
  KINDS.map((kind) => {
    const docs = kind === "playbooks" ? corpus.playbooks.map(playbookToDoc) : corpus.groundTruth.map(groundTruthToDoc);
    const hash = contentHash(docs, model);
    return [kind, { docs, hash, name: indexName(kind, hash) }];
  }),
) as Record<IndexKind, { docs: MossDoc[]; hash: string; name: string }>;

section(`Build plan (model ${model})`);
console.log(table(["index", "docs", "name"], KINDS.map((k) => [k, plan[k].docs.length, plan[k].name])));

if (args["dry-run"]) {
  console.log(c.dim("\n--dry-run: no network calls made."));
  process.exit(0);
}

const { projectId, projectKey } = mossCredentials();
const client = new MossClient(projectId, projectKey);

try {
  const existing = new Map((await client.listIndexes()).map((i) => [i.name, i]));
  const entries = {} as Record<IndexKind, IndexManifestEntry>;

  for (const kind of KINDS) {
    const { docs, hash, name } = plan[kind];
    section(`${kind} → ${name}`);
    const prior = existing.get(name);
    let buildMs: number | null = null;

    if (prior && !args.force && String(prior.status) === "Ready" && prior.docCount === docs.length) {
      console.log(c.dim(`  exists with ${prior.docCount} docs and identical content hash; reusing`));
    } else {
      if (prior) {
        console.log(c.yellow(`  deleting existing ${name} (status ${prior.status}, ${prior.docCount} docs)`));
        await client.deleteIndex(name);
      }
      let last = "";
      const t0 = performance.now();
      await client.createIndex(name, docs, {
        modelId: model,
        onProgress: (p) => {
          const line = `${p.status}${p.currentPhase ? ` / ${p.currentPhase}` : ""} ${Math.round(p.progress)}%`;
          if (line !== last) console.log(c.dim(`  ${line}`));
          last = line;
        },
      });
      buildMs = performance.now() - t0;
      console.log(`  built in ${(buildMs / 1000).toFixed(1)}s`);
    }

    const info = await client.getIndex(name);
    if (String(info.status) !== "Ready") throw new Error(`${name}: status ${info.status}, expected Ready`);
    if (info.docCount !== docs.length) throw new Error(`${name}: Moss reports ${info.docCount} docs, expected ${docs.length}`);
    if (info.model?.id && info.model.id !== model) throw new Error(`${name}: built with model ${info.model.id}, expected ${model}`);
    console.log(c.dim(`  confirmed: Ready, ${info.docCount} docs, model ${info.model?.id} ${info.model?.version ?? ""}`));
    entries[kind] = { name, hash, docCount: info.docCount, buildMs };
  }

  // Manifest + client join table.
  mkdirSync(DIST_DIR, { recursive: true });
  const manifestPath = join(DIST_DIR, "manifest.json");
  const prev = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as CorpusManifest) : null;
  const previous: CorpusManifest["previous"] = {};
  for (const kind of KINDS) {
    const prevName = prev?.indexes[kind]?.name;
    previous[kind] = prevName && prevName !== entries[kind].name ? prevName : prev?.previous[kind];
  }
  const manifest: CorpusManifest = { schemaVersion: SCHEMA_VERSION, model, builtAt: new Date().toISOString(), indexes: entries, previous };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(
    join(DIST_DIR, "client-corpus.json"),
    JSON.stringify({
      version: `${entries.playbooks.hash}.${entries.ground_truth.hash}`,
      playbooks: corpus.playbooks,
      groundTruth: corpus.groundTruth,
      fixtures: corpus.fixtures,
    }) + "\n",
  );
  console.log(c.green(`\n✓ wrote corpus/dist/manifest.json and corpus/dist/client-corpus.json`));

  if (args.prune) {
    section("Prune");
    const keep = new Set([...KINDS.map((k) => entries[k].name), ...Object.values(previous).filter(Boolean)]);
    for (const name of existing.keys()) {
      if (name.startsWith(`${INDEX_PREFIX}-`) && !keep.has(name)) {
        await client.deleteIndex(name);
        console.log(c.yellow(`  deleted ${name}`));
      }
    }
  }

  // Smoke test: the published index loads in the Node runtime and retrieves a document from its own text.
  if (args["skip-smoke"]) {
    console.log(c.dim("\n--skip-smoke: Node local load + self-retrieval not run."));
  } else {
    section("Smoke test (Node local load + self-retrieval)");
    try {
      const smokeRows: (string | number)[][] = [];
      for (const kind of KINDS) {
        const { docs, name } = plan[kind];
        const t0 = performance.now();
        await client.loadIndex(name);
        const loadMs = performance.now() - t0;
        const step = Math.max(1, Math.floor(docs.length / SMOKE_SAMPLES));
        const sample = docs.filter((_, i) => i % step === 0).slice(0, SMOKE_SAMPLES);
        const misses: string[] = [];
        for (const d of sample) {
          const r = await client.query(name, d.text, { topK: 1, alpha: 1 });
          if (r.docs[0]?.id !== d.id) misses.push(`${d.id} → ${r.docs[0]?.id ?? "nothing"}`);
        }
        smokeRows.push([kind, fmtMs(loadMs), `${sample.length - misses.length}/${sample.length}`]);
        if (misses.length) throw new Error(`self-retrieval failed on ${kind}: ${misses.join(", ")}`);
      }
      console.log(table(["index", "loadIndex ms", "self-retrieval"], smokeRows));
    } catch (err) {
      console.error(c.red(`  ✗ ${err instanceof Error ? err.message : String(err)}`));
      console.error(
        c.yellow(
          "  Indexes are published and the manifest is written, but the Node runtime could not verify them locally.\n" +
            "  Verify through the browser WASM runtime the app uses: npm run index:verify:browser",
        ),
      );
      process.exitCode = 1;
    }
  }
} catch (err) {
  console.error(c.red(`\n✗ build failed: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
} finally {
  await client.close();
}
