/**
 * Loads corpus JSON from corpus/data, validates every record against the
 * schema, and runs cross-record checks that a per-record schema cannot:
 * unique ids, referential integrity, coverage targets, and train/test leakage.
 *
 * Three disjoint sets of call-shaped text exist, and none may copy another:
 *   playbooks + ground truth  indexed in Moss
 *   dev calls                 calibration only (corpus/data/dev)
 *   fixture calls + probes    held-out evaluation (corpus/data/fixtures, probes.json)
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  FixtureCallSchema,
  GroundTruthEntrySchema,
  PlaybookEntrySchema,
  ProbeSetSchema,
  SCAM_FAMILIES,
  STAGES,
  type FixtureCall,
  type GroundTruthEntry,
  type PlaybookEntry,
  type ProbeSet,
} from "./schema";

export const DATA_DIR = join(import.meta.dirname, "data");

export interface Corpus {
  playbooks: PlaybookEntry[];
  groundTruth: GroundTruthEntry[];
  fixtures: FixtureCall[];
  /** Calibration calls; never used for reported evaluation. */
  dev: FixtureCall[];
  probes: ProbeSet;
}

export class CorpusError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Corpus invalid (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n  - ${problems.join("\n  - ")}`);
  }
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

function parseArray<T>(schema: z.ZodType<T>, raw: unknown, file: string, problems: string[]): T[] {
  if (!Array.isArray(raw)) {
    problems.push(`${file}: expected a JSON array`);
    return [];
  }
  const out: T[] = [];
  raw.forEach((item, i) => {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
    else {
      const id = (item as { id?: string })?.id ?? `#${i}`;
      for (const issue of r.error.issues) problems.push(`${file} ${id} ${issue.path.join(".")}: ${issue.message}`);
    }
  });
  return out;
}

function parseDir<T>(schema: z.ZodType<T>, dir: string, label: string, problems: string[]): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => parseArray(schema, readJson(join(dir, f)), `${label}/${f}`, problems));
}

// Coverage targets from the product spec.
export const TARGETS = { playbooksMin: 80, playbooksMax: 150, groundTruthMin: 40, scamFixtures: 6, benignFixtures: 4 } as const;
const MIN_PER_FAMILY_STAGE = 2;
const MIN_BENIGN = 12;
const LEAK_NGRAM = 7;

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

function ngrams(s: string, n: number): Set<string> {
  const w = normalize(s);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

export function loadCorpus(dataDir = DATA_DIR): Corpus {
  const problems: string[] = [];

  const playbooks = parseDir(PlaybookEntrySchema, join(dataDir, "playbooks"), "playbooks", problems);
  const groundTruth = parseArray(GroundTruthEntrySchema, readJson(join(dataDir, "ground-truth.json")), "ground-truth.json", problems);
  const fixtures = parseDir(FixtureCallSchema, join(dataDir, "fixtures"), "fixtures", problems);
  const dev = parseDir(FixtureCallSchema, join(dataDir, "dev"), "dev", problems);

  const probesParsed = ProbeSetSchema.safeParse(readJson(join(dataDir, "probes.json")));
  const probes: ProbeSet = probesParsed.success ? probesParsed.data : { playbook: [], claim: [] };
  if (!probesParsed.success) {
    for (const issue of probesParsed.error.issues) problems.push(`probes.json ${issue.path.join(".")}: ${issue.message}`);
  }

  for (const f of fixtures) if (!f.id.startsWith("fx.")) problems.push(`fixture ${f.id}: fixture ids must start with fx.`);
  for (const d of dev) if (!d.id.startsWith("dev.")) problems.push(`dev call ${d.id}: dev ids must start with dev.`);

  // Unique ids across everything.
  const seen = new Map<string, number>();
  for (const id of [...playbooks, ...groundTruth, ...fixtures, ...dev, ...probes.playbook, ...probes.claim].map((r) => r.id)) {
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const [id, n] of seen) if (n > 1) problems.push(`duplicate id ${id} (${n}x)`);

  // Duplicate texts in an index waste a top-k slot and skew scores.
  const texts = new Map<string, string>();
  for (const e of playbooks) {
    const key = normalize(e.text).join(" ");
    const other = texts.get(key);
    if (other) problems.push(`playbook ${e.id} duplicates text of ${other}`);
    texts.set(key, e.id);
  }

  // Referential integrity.
  const gtIds = new Set(groundTruth.map((g) => g.id));
  for (const f of [...fixtures, ...dev]) {
    f.turns.forEach((t, i) =>
      t.claims?.forEach((c) => {
        if (c.groundTruthId && !gtIds.has(c.groundTruthId)) problems.push(`call ${f.id} turn ${i}: unknown groundTruthId ${c.groundTruthId}`);
      }),
    );
  }
  for (const p of probes.claim) {
    if (p.expectGroundTruthId && !gtIds.has(p.expectGroundTruthId)) problems.push(`probe ${p.id}: unknown groundTruthId ${p.expectGroundTruthId}`);
    if ((p.expectVerdict === "unverifiable") !== (p.expectGroundTruthId === null)) {
      problems.push(`probe ${p.id}: expectGroundTruthId must be null iff expectVerdict is unverifiable`);
    }
    const gt = groundTruth.find((g) => g.id === p.expectGroundTruthId);
    if (gt && (gt.stance === "refutes") !== (p.expectVerdict === "false")) {
      problems.push(`probe ${p.id}: verdict ${p.expectVerdict} inconsistent with ${gt.id} stance ${gt.stance}`);
    }
  }

  // Coverage.
  if (playbooks.length < TARGETS.playbooksMin || playbooks.length > TARGETS.playbooksMax) {
    problems.push(`playbooks: ${playbooks.length} entries, target ${TARGETS.playbooksMin}-${TARGETS.playbooksMax}`);
  }
  for (const fam of SCAM_FAMILIES) {
    for (const stage of STAGES) {
      const n = playbooks.filter((e) => e.family === fam && e.stage === stage).length;
      if (n < MIN_PER_FAMILY_STAGE) problems.push(`coverage: ${fam}/${stage} has ${n}, need ≥${MIN_PER_FAMILY_STAGE}`);
    }
  }
  const benign = playbooks.filter((e) => e.family === "benign").length;
  if (benign < MIN_BENIGN) problems.push(`coverage: ${benign} benign contrast entries, need ≥${MIN_BENIGN}`);
  if (groundTruth.length < TARGETS.groundTruthMin) problems.push(`ground truth: ${groundTruth.length} entries, need ≥${TARGETS.groundTruthMin}`);
  if (!groundTruth.some((g) => g.stance === "supports")) problems.push("ground truth: no 'supports' entries; benign calls would have nothing to match");
  const scamFx = fixtures.filter((f) => f.label === "scam");
  if (scamFx.length < TARGETS.scamFixtures) problems.push(`fixtures: ${scamFx.length} scam calls, need ≥${TARGETS.scamFixtures}`);
  if (new Set(scamFx.map((f) => f.family)).size < TARGETS.scamFixtures) problems.push("fixtures: scam calls must span ≥6 distinct families");
  if (fixtures.filter((f) => f.label === "benign").length < TARGETS.benignFixtures) problems.push(`fixtures: need ≥${TARGETS.benignFixtures} benign calls`);

  // Leakage: evaluation and calibration text must not share long n-grams with
  // indexed text (inflates retrieval scores) or with each other (calibrating on
  // the test set by proxy).
  const index = (owner: Map<string, string>, id: string, text: string) => {
    for (const g of ngrams(text, LEAK_NGRAM)) owner.set(g, id);
  };
  const indexed = new Map<string, string>();
  for (const e of playbooks) index(indexed, e.id, e.text);
  for (const e of groundTruth) index(indexed, e.id, e.claim);
  const heldOut = new Map<string, string>();
  for (const f of fixtures) f.turns.forEach((t, i) => index(heldOut, `${f.id} turn ${i}`, t.text));
  for (const p of [...probes.playbook, ...probes.claim]) index(heldOut, p.id, p.text);

  const checkLeak = (owner: string, text: string, against: Map<string, string>, what: string) => {
    for (const g of ngrams(text, LEAK_NGRAM)) {
      const src = against.get(g);
      if (src) {
        problems.push(`leakage: ${owner} shares ${LEAK_NGRAM}-gram "${g}" with ${what} ${src}`);
        return;
      }
    }
  };
  for (const f of fixtures) f.turns.forEach((t, i) => checkLeak(`${f.id} turn ${i}`, t.text, indexed, "indexed"));
  for (const p of [...probes.playbook, ...probes.claim]) checkLeak(p.id, p.text, indexed, "indexed");
  for (const d of dev) {
    d.turns.forEach((t, i) => {
      checkLeak(`${d.id} turn ${i}`, t.text, indexed, "indexed");
      checkLeak(`${d.id} turn ${i}`, t.text, heldOut, "held-out");
    });
  }

  if (problems.length) throw new CorpusError(problems);
  return { playbooks, groundTruth, fixtures, dev, probes };
}
