/**
 * In-page harness for the CLI browser scripts. Bundled with esbuild and run in
 * headless Chrome on top of lib/moss/runtime.ts, the same runtime the app uses.
 */
import { MossRuntime, type Hit, type QueryOptions, type RuntimeConfig, type RuntimeInfo } from "../../lib/moss/runtime";
import { rescore } from "../../lib/detection/scoring";
import { cosine, decodeVectors, type EncodedVectors } from "../../lib/detection/vectors";

export interface HarnessConfig extends RuntimeConfig {
  /** Document embeddings keyed by index name; enables cosine on returned hits. */
  docVectors?: Record<string, EncodedVectors>;
}

export interface HarnessHit extends Hit {
  cosine?: number;
}

export interface HarnessBench {
  totalMs: number[];
  embedMs: number[];
  searchMs: number[];
  rescoreMs: number[];
}

export interface ParityMismatch {
  kind: "split-vs-query" | "query-vs-query";
  index: string;
  text: string;
  note: string;
  a: Hit[];
  b: Hit[];
}

export interface ParityResult {
  checked: number;
  epsilon: number;
  maxScoreDelta: number;
  mismatches: ParityMismatch[];
}

export interface DiagnoseRow {
  index: string;
  text: string;
  /** Max |Δ| of any embedding component across repeated embeds of the same text. */
  embedMaxDelta: number;
  alphas: Record<
    string,
    {
      /** Repeated search with one fixed embedding. */
      searchMaxDelta: number;
      searchOrderStable: boolean;
      /** Repeated public client.query (fresh embedding each time). */
      queryMaxDelta: number;
      queryOrderStable: boolean;
      first: Hit[];
    }
  >;
}

export interface Harness {
  init(cfg: HarnessConfig): Promise<RuntimeInfo>;
  parity(indexes: string[], texts: string[]): Promise<ParityResult>;
  diagnose(indexes: string[], texts: string[], repeats: number): Promise<DiagnoseRow[]>;
  queryBatch(index: string, texts: string[], opts: QueryOptions): Promise<HarnessHit[][]>;
  bench(index: string, texts: string[], iters: number, opts: QueryOptions): Promise<HarnessBench>;
  embedMany(texts: string[]): Promise<number[][]>;
}

declare global {
  interface Window {
    __kavach: Harness;
  }
}

const PARITY_EPSILON = 1e-4;

let runtime: MossRuntime;
const vectors = new Map<string, Map<string, Float32Array>>();

function need(): MossRuntime {
  if (!runtime) throw new Error("harness not initialised");
  return runtime;
}

/** Moss top-k re-scored by cosine, with phase timings: the same shape the app's retrieval worker returns. */
export async function scoredQuery(index: string, text: string, opts: QueryOptions) {
  const q = await need().query(index, text, opts);
  const docVecs = vectors.get(index);
  const t = performance.now();
  const hits = q.hits
    .map((h, i) => {
      const v = docVecs?.get(h.id);
      return { id: h.id, score: h.score, rank: i + 1, cosine: v ? cosine(q.embedding, v) : 0 };
    })
    .sort((a, b) => b.cosine - a.cosine);
  const rescoreMs = performance.now() - t;
  return { hits, embedMs: q.embedMs, searchMs: q.searchMs, rescoreMs, totalMs: q.totalMs + rescoreMs };
}

/** Same ids with per-id scores within epsilon; rank order may differ only between tied scores. */
function compareHits(a: Hit[], b: Hit[]): { same: boolean; maxDelta: number; note: string } {
  if (a.length !== b.length) return { same: false, maxDelta: Infinity, note: `result count ${a.length} vs ${b.length}` };
  const scoresB = new Map(b.map((d) => [d.id, d.score]));
  let maxDelta = 0;
  for (const d of a) {
    const s = scoresB.get(d.id);
    if (s === undefined) return { same: false, maxDelta: Infinity, note: `${d.id} missing from second result` };
    maxDelta = Math.max(maxDelta, Math.abs(s - d.score));
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.id !== b[i]!.id && Math.abs(a[i]!.score - b[i]!.score) > PARITY_EPSILON) {
      return { same: false, maxDelta, note: `rank ${i + 1}: ${a[i]!.id} vs ${b[i]!.id}` };
    }
  }
  return maxDelta <= PARITY_EPSILON ? { same: true, maxDelta, note: "" } : { same: false, maxDelta, note: `score delta ${maxDelta.toExponential(2)}` };
}

/** Spread of repeated runs against the first: max per-id score delta and whether id order ever changed. */
function spread(runs: Hit[][]): { maxDelta: number; orderStable: boolean } {
  const [first, ...rest] = runs;
  let maxDelta = 0;
  let orderStable = true;
  const base = new Map(first!.map((h) => [h.id, h.score]));
  for (const run of rest) {
    if (run.map((h) => h.id).join() !== first!.map((h) => h.id).join()) orderStable = false;
    for (const h of run) {
      const s = base.get(h.id);
      if (s !== undefined) maxDelta = Math.max(maxDelta, Math.abs(h.score - s));
    }
  }
  return { maxDelta, orderStable };
}

window.__kavach = {
  async init(cfg) {
    const { docVectors, ...runtimeCfg } = cfg;
    for (const [index, enc] of Object.entries(docVectors ?? {})) vectors.set(index, decodeVectors(enc));
    runtime = await MossRuntime.create(runtimeCfg);
    return runtime.info;
  },

  async parity(indexes, texts) {
    const rt = need();
    // alpha 1 (pure semantic) is bit-deterministic in moss-web 1.0.1; the keyword component breaks
    // score ties nondeterministically (see --diagnose), which would mask a real split-path divergence.
    const opts = { topK: 3, alpha: 1 };
    const mismatches: ParityMismatch[] = [];
    let maxScoreDelta = 0;
    let checked = 0;
    for (const index of indexes) {
      for (const text of texts) {
        const pub = await rt.publicQuery(index, text, opts);
        const pubAgain = await rt.publicQuery(index, text, opts);
        const split = (await rt.query(index, text, opts)).hits;
        for (const [kind, a, b] of [
          ["split-vs-query", pub, split],
          ["query-vs-query", pub, pubAgain],
        ] as const) {
          checked++;
          const cmp = compareHits(a, b);
          if (Number.isFinite(cmp.maxDelta)) maxScoreDelta = Math.max(maxScoreDelta, cmp.maxDelta);
          if (!cmp.same) mismatches.push({ kind, index, text, note: cmp.note, a, b });
        }
      }
    }
    return { checked, epsilon: PARITY_EPSILON, maxScoreDelta, mismatches };
  },

  async diagnose(indexes, texts, repeats) {
    const rt = need();
    const rows: DiagnoseRow[] = [];
    for (const index of indexes) {
      for (const text of texts) {
        const embeddings: Float32Array[] = [];
        for (let i = 0; i < repeats; i++) embeddings.push(await rt.embed(text));
        let embedMaxDelta = 0;
        for (const e of embeddings.slice(1)) {
          for (let j = 0; j < e.length; j++) embedMaxDelta = Math.max(embedMaxDelta, Math.abs(e[j]! - embeddings[0]![j]!));
        }
        const alphas: DiagnoseRow["alphas"] = {};
        for (const alpha of [1, 0.8, 0]) {
          const searchRuns: Hit[][] = [];
          const queryRuns: Hit[][] = [];
          for (let i = 0; i < repeats; i++) {
            searchRuns.push(await rt.search(index, text, embeddings[0]!, { topK: 3, alpha }));
            queryRuns.push(await rt.publicQuery(index, text, { topK: 3, alpha }));
          }
          const s = spread(searchRuns);
          const q = spread(queryRuns);
          alphas[String(alpha)] = { searchMaxDelta: s.maxDelta, searchOrderStable: s.orderStable, queryMaxDelta: q.maxDelta, queryOrderStable: q.orderStable, first: queryRuns[0]! };
        }
        rows.push({ index, text, embedMaxDelta, alphas });
      }
    }
    return rows;
  },

  async queryBatch(index, texts, opts) {
    const rt = need();
    const docVecs = vectors.get(index);
    const out: HarnessHit[][] = [];
    for (const text of texts) {
      const q = await rt.query(index, text, opts);
      out.push(
        q.hits.map((h) => {
          const v = docVecs?.get(h.id);
          return v ? { ...h, cosine: cosine(q.embedding, v) } : h;
        }),
      );
    }
    return out;
  },

  async bench(index, texts, iters, opts) {
    const rt = need();
    const docVecs = vectors.get(index);
    for (let i = 0; i < 30; i++) await rt.query(index, texts[i % texts.length]!, opts); // warm-up, discarded
    const r: HarnessBench = { totalMs: [], embedMs: [], searchMs: [], rescoreMs: [] };
    for (let i = 0; i < iters; i++) {
      const q = await rt.query(index, texts[i % texts.length]!, opts);
      r.totalMs.push(q.totalMs);
      r.embedMs.push(q.embedMs);
      r.searchMs.push(q.searchMs);
      if (docVecs) {
        const t = performance.now();
        rescore(q.hits, q.embedding, docVecs);
        r.rescoreMs.push(performance.now() - t);
      }
    }
    return r;
  },

  async embedMany(texts) {
    const rt = need();
    const out: number[][] = [];
    for (const text of texts) out.push(Array.from(await rt.embed(text)));
    return out;
  },
};
