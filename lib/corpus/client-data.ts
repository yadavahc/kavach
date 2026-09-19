/** Loads the built corpus artifacts the browser needs (served from /data by `npm run vendor`). */
import type { CorpusManifest } from "../../corpus/docs";
import type { FixtureCall, GroundTruthEntry, PlaybookEntry } from "../../corpus/schema";
import type { DocEmbeddingsFile } from "../detection/vectors";

export interface ClientCorpus {
  version: string;
  playbooks: PlaybookEntry[];
  groundTruth: GroundTruthEntry[];
  fixtures: FixtureCall[];
}

export interface CorpusBundle {
  manifest: CorpusManifest;
  corpus: ClientCorpus;
  embeddings: DocEmbeddingsFile;
  playbookById: Map<string, PlaybookEntry>;
  groundTruthById: Map<string, GroundTruthEntry>;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

let cached: Promise<CorpusBundle> | null = null;

export function loadCorpusBundle(): Promise<CorpusBundle> {
  cached ??= (async () => {
    const [manifest, corpus, embeddings] = await Promise.all([
      getJson<CorpusManifest>("/data/manifest.json"),
      getJson<ClientCorpus>("/data/client-corpus.json"),
      getJson<DocEmbeddingsFile>("/data/doc-embeddings.json"),
    ]);
    const version = `${manifest.indexes.playbooks.hash}.${manifest.indexes.ground_truth.hash}`;
    if (corpus.version !== version) throw new Error(`client corpus ${corpus.version} does not match manifest ${version}`);
    if (embeddings.corpusVersion !== version || embeddings.model !== manifest.model) {
      throw new Error(`document embeddings (${embeddings.corpusVersion}, ${embeddings.model}) do not match manifest (${version}, ${manifest.model})`);
    }
    return {
      manifest,
      corpus,
      embeddings,
      playbookById: new Map(corpus.playbooks.map((e) => [e.id, e])),
      groundTruthById: new Map(corpus.groundTruth.map((e) => [e.id, e])),
    };
  })().catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}
