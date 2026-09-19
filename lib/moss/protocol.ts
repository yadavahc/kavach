/** Message protocol between the app and the retrieval worker. */
import type { EncodedVectors } from "../detection/vectors";
import type { QueryOptions, RuntimeConfig, RuntimeInfo } from "./runtime";

export const RUNTIME_URLS = {
  worker: "/vendor/kavach/worker.js",
  mossWasm: "/vendor/moss/moss_wasm_bg.wasm",
  ortDir: "/vendor/ort/",
} as const;

export interface InitPayload {
  config: RuntimeConfig;
  /** Document embeddings keyed by index name. */
  docVectors: Record<string, EncodedVectors>;
}

export interface QueryPayload {
  index: string;
  text: string;
  opts: QueryOptions;
}

export interface RetrievedHit {
  id: string;
  /** Moss score (rank-derived). */
  score: number;
  /** 1-based rank in Moss's result. */
  rank: number;
  /** Cosine similarity between the query and this document. */
  cosine: number;
}

export interface QueryResult {
  /** Moss's top-k, sorted by cosine (descending). */
  hits: RetrievedHit[];
  embedMs: number;
  searchMs: number;
  rescoreMs: number;
  /** embed + search + re-score, measured inside the worker. */
  totalMs: number;
}

export type WorkerRequest = { id: number; type: "init"; payload: InitPayload } | { id: number; type: "query"; payload: QueryPayload };

export type WorkerResult = RuntimeInfo | QueryResult;

export type WorkerResponse = { id: number; ok: true; result: WorkerResult } | { id: number; ok: false; error: string };
