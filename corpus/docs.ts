/**
 * Corpus -> Moss documents, plus content-addressed versioning.
 *
 * Index names embed a hash of exactly what Moss will embed (id, text, metadata,
 * model), so a published index is immutable: any corpus edit produces a new
 * index name, and corpus/dist/manifest.json is the pointer the app follows.
 */
import { createHash } from "node:crypto";
import { SCHEMA_VERSION, type GroundTruthEntry, type PlaybookEntry } from "./schema";

export interface MossDoc {
  id: string;
  text: string;
  metadata: Record<string, string>;
}

export type IndexKind = "playbooks" | "ground_truth";

export function playbookToDoc(e: PlaybookEntry): MossDoc {
  return {
    id: e.id,
    text: e.text,
    metadata: {
      kind: "playbook",
      family: e.family,
      stage: e.stage,
      severity: String(e.severity),
      impersonates: e.impersonates,
      locale: e.locale,
    },
  };
}

/** Embedded text is the assertion-shaped claim; the fact is evidence, joined back client-side. */
export function groundTruthToDoc(e: GroundTruthEntry): MossDoc {
  return {
    id: e.id,
    text: e.claim,
    metadata: {
      kind: "ground_truth",
      topic: e.topic,
      stance: e.stance,
      locale: e.locale,
      families: e.families.join(","),
    },
  };
}

function canonical(docs: MossDoc[]): string {
  const sorted = [...docs].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(
    sorted.map((d) => [d.id, d.text, Object.entries(d.metadata).sort(([a], [b]) => a.localeCompare(b))]),
  );
}

export function contentHash(docs: MossDoc[], model: string): string {
  return createHash("sha256")
    .update(`schema:${SCHEMA_VERSION}\nmodel:${model}\n`)
    .update(canonical(docs))
    .digest("hex")
    .slice(0, 10);
}

export const INDEX_PREFIX = "kavach";

export function indexName(kind: IndexKind, hash: string): string {
  return `${INDEX_PREFIX}-${kind.replace("_", "-")}-${hash}`;
}

export interface IndexManifestEntry {
  name: string;
  hash: string;
  docCount: number;
  buildMs: number | null; // null when the index already existed and was reused
}

export interface CorpusManifest {
  schemaVersion: number;
  model: string;
  builtAt: string;
  indexes: Record<IndexKind, IndexManifestEntry>;
  /** Previous manifest's index names, retained for one-step rollback. */
  previous: Partial<Record<IndexKind, string>>;
}
