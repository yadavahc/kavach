/**
 * Browser retrieval runtime: @moss-dev/moss-web with the embed and search
 * steps timed separately. The app (inside a Web Worker) and the headless
 * verification harness both use this module, so they measure the same path.
 */
import * as ort from "onnxruntime-web";
import { MossClient } from "@moss-dev/moss-web";

export type MossModelId = "moss-minilm" | "moss-mediumlm";

export interface RuntimeConfig {
  projectId: string;
  projectKey: string;
  model: MossModelId;
  indexes: string[];
  /** URL of moss_wasm_bg.wasm. */
  wasmUrl: string;
  /** Directory URL holding ort-wasm-simd-threaded.{mjs,wasm}. */
  onnxWasmPath: string;
  /** ONNX Runtime WASM threads. Omit for ORT's default. */
  ortThreads?: number;
}

export interface Hit {
  id: string;
  /** Moss score. Rank-derived and fused by alpha in moss-web 1.0.1, not a similarity. */
  score: number;
}

export interface QueryOptions {
  topK: number;
  alpha: number;
}

export interface TimedQuery {
  hits: Hit[];
  embedding: Float32Array;
  embedMs: number;
  searchMs: number;
  totalMs: number;
}

export interface RuntimeInfo {
  crossOriginIsolated: boolean;
  hardwareConcurrency: number;
  userAgent: string;
  timerResolutionMs: number;
  ortNumThreads: number | undefined;
  initMs: number;
  loadIndexMs: Record<string, number>;
}

interface Embedder {
  embed(text: string): Promise<Float32Array>;
}

/**
 * MossClient (moss-web 1.0.1) internals. Its query() is exactly
 * getEmbedder(model).embed(text) followed by indexManager.query(...); calling
 * the two steps directly is what lets us time them separately. Equivalence is
 * asserted by scripts/verify-browser.ts (parity check at alpha 1).
 */
interface MossInternals {
  ensureInitialized(): Promise<void>;
  getEmbedder(model: string): Promise<Embedder>;
  indexManager: {
    query(index: string, text: string, embedding: Float32Array, topK?: number, alpha?: number, filter?: unknown): Promise<{ docs: Hit[] }>;
  };
}

const toHits = (docs: Hit[]): Hit[] => docs.map((d) => ({ id: d.id, score: d.score }));

export function measureTimerResolutionMs(samples = 200_000): number {
  let min = Infinity;
  let last = performance.now();
  for (let i = 0; i < samples; i++) {
    const now = performance.now();
    const d = now - last;
    if (d > 0 && d < min) min = d;
    last = now;
  }
  return min;
}

export class MossRuntime {
  private constructor(
    private readonly client: MossClient,
    private readonly internals: MossInternals,
    private readonly embedder: Embedder,
    readonly info: RuntimeInfo,
  ) {}

  static async create(cfg: RuntimeConfig): Promise<MossRuntime> {
    if (cfg.ortThreads !== undefined) ort.env.wasm.numThreads = cfg.ortThreads;
    const client = new MossClient(cfg.projectId, cfg.projectKey, { model: cfg.model, wasmUrl: cfg.wasmUrl, onnxWasmPath: cfg.onnxWasmPath });
    const internals = client as unknown as MossInternals;

    const t0 = performance.now();
    await internals.ensureInitialized(); // WASM + tokenizer + ONNX model
    const embedder = await internals.getEmbedder(cfg.model);
    const initMs = performance.now() - t0;

    const loadIndexMs: Record<string, number> = {};
    for (const name of cfg.indexes) {
      const t = performance.now();
      await client.loadIndex(name);
      loadIndexMs[name] = performance.now() - t;
    }

    return new MossRuntime(client, internals, embedder, {
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      hardwareConcurrency: navigator.hardwareConcurrency,
      userAgent: navigator.userAgent,
      timerResolutionMs: measureTimerResolutionMs(),
      ortNumThreads: ort.env.wasm.numThreads,
      initMs,
      loadIndexMs,
    });
  }

  embed(text: string): Promise<Float32Array> {
    return this.embedder.embed(text);
  }

  async search(index: string, text: string, embedding: Float32Array, opts: QueryOptions): Promise<Hit[]> {
    return toHits((await this.internals.indexManager.query(index, text, embedding, opts.topK, opts.alpha, undefined)).docs);
  }

  /** Embed + search with each phase timed. */
  async query(index: string, text: string, opts: QueryOptions): Promise<TimedQuery> {
    const t0 = performance.now();
    const embedding = await this.embedder.embed(text);
    const t1 = performance.now();
    const hits = await this.search(index, text, embedding, opts);
    const t2 = performance.now();
    return { hits, embedding, embedMs: t1 - t0, searchMs: t2 - t1, totalMs: t2 - t0 };
  }

  /** The SDK's public query(), used only to assert the split path is equivalent. */
  async publicQuery(index: string, text: string, opts: QueryOptions): Promise<Hit[]> {
    return toHits((await this.client.query(index, text, opts)).docs);
  }

  dispose(): void {
    this.client.dispose();
  }
}
