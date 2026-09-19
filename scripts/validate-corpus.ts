/**
 * Offline corpus check (no Moss credentials needed).
 *   npm run corpus:validate
 */
import { CorpusError, loadCorpus } from "../corpus/load";
import { contentHash, groundTruthToDoc, indexName, playbookToDoc } from "../corpus/docs";
import { GT_TOPICS, SCAM_FAMILIES, STAGES, wordCount } from "../corpus/schema";
import { c, loadEnv, resolveModel, section, table } from "./lib/cli";

loadEnv();
const model = resolveModel(undefined);

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
const { playbooks, groundTruth, fixtures, probes } = corpus;

section(`Playbooks: ${playbooks.length} entries`);
console.log(
  table(
    ["family", ...STAGES, "total"],
    [
      ...SCAM_FAMILIES.map((f) => {
        const counts = STAGES.map((s) => playbooks.filter((e) => e.family === f && e.stage === s).length);
        return [f, ...counts, counts.reduce((a, b) => a + b, 0)];
      }),
      ["benign (contrast)", ...STAGES.map(() => "-"), playbooks.filter((e) => e.family === "benign").length],
    ],
  ),
);
const words = playbooks.map((e) => wordCount(e.text));
console.log(c.dim(`words/entry: min ${Math.min(...words)}, mean ${(words.reduce((a, b) => a + b, 0) / words.length).toFixed(1)}, max ${Math.max(...words)}`));

section(`Ground truth: ${groundTruth.length} entries`);
console.log(
  table(
    ["topic", "refutes", "supports"],
    GT_TOPICS.map((t) => [
      t,
      groundTruth.filter((g) => g.topic === t && g.stance === "refutes").length,
      groundTruth.filter((g) => g.topic === t && g.stance === "supports").length,
    ]),
  ),
);

section(`Fixture calls: ${fixtures.length}`);
console.log(
  table(
    ["id", "label", "family", "turns", "duration s", "onset s", "extraction s", "claims"],
    fixtures.map((f) => [
      f.id,
      f.label,
      f.family ?? "-",
      f.turns.length,
      f.turns.at(-1)!.end.toFixed(0),
      f.onsetTurn === null ? "-" : f.turns[f.onsetTurn]!.start.toFixed(1),
      f.extractionTurn === null ? "-" : f.turns[f.extractionTurn]!.start.toFixed(1),
      f.turns.reduce((n, t) => n + (t.claims?.length ?? 0), 0),
    ]),
  ),
);

section("Probes");
console.log(`playbook probes: ${probes.playbook.length}, claim probes: ${probes.claim.length}`);

section(`Index plan (model ${model})`);
const pb = playbooks.map(playbookToDoc);
const gt = groundTruth.map(groundTruthToDoc);
console.log(
  table(
    ["index", "docs", "name"],
    [
      ["playbooks", pb.length, indexName("playbooks", contentHash(pb, model))],
      ["ground_truth", gt.length, indexName("ground_truth", contentHash(gt, model))],
    ],
  ),
);
console.log(c.green("\n✓ corpus valid"));
