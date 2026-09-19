/**
 * Main-thread side of the retrieval worker. Every query result carries the
 * worker's own phase timings plus the round trip measured on this thread.
 */
import type { CorpusBundle } from "../corpus/client-data";
import { RUNTIME_URLS, type QueryResult, type WorkerRequest, type WorkerResponse, type WorkerResult } from "./protocol";
import type { MossModelId, QueryOptions, RuntimeInfo } from "./runtime";

export interface ClientQueryResult extends QueryResult {
  /** Latency the detection pipeline experiences: measured round trip plus any simulated network time. */
  roundTripMs: number;
  /** Simulated network time (0 for on-device retrieval). */
  networkMs: number;
}

export interface Retriever {
  readonly label: string;
  query(index: string, text: string, opts: QueryOptions): Promise<ClientQueryResult>;
}

export interface MossCredentials {
  projectId: string;
  projectKey: string;
}

export async function fetchMossCredentials(): Promise<MossCredentials> {
  const res = await fetch("/api/moss-config", { cache: "no-store" });
  const body = (await res.json()) as Partial<MossCredentials> & { error?: string };
  if (!res.ok || !body.projectId || !body.projectKey) throw new Error(body.error ?? `Moss config unavailable (HTTP ${res.status})`);
  return { projectId: body.projectId, projectKey: body.projectKey };
}

type Body<T> = T extends unknown ? Omit<T, "id"> : never;
type RequestBody = Body<WorkerRequest>;

interface Pending {
  resolve(result: WorkerResult): void;
  reject(err: Error): void;
}

export class RetrievalWorker implements Retriever {
  readonly label = "Moss on-device";
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private runtimeInfo: RuntimeInfo | null = null;

  private constructor(private readonly worker: Worker) {
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      if (ev.data.ok) p.resolve(ev.data.result);
      else p.reject(new Error(ev.data.error));
    };
    worker.onerror = (ev) => this.failAll(new Error(ev.message || "retrieval worker failed to load"));
  }

  get info(): RuntimeInfo {
    if (!this.runtimeInfo) throw new Error("retrieval worker not initialised");
    return this.runtimeInfo;
  }

  static async start(bundle: CorpusBundle, creds: MossCredentials, opts: { ortThreads?: number } = {}): Promise<RetrievalWorker> {
    const rw = new RetrievalWorker(new Worker(RUNTIME_URLS.worker, { type: "module", name: "kavach-retrieval" }));
    const pb = bundle.manifest.indexes.playbooks.name;
    const gt = bundle.manifest.indexes.ground_truth.name;
    try {
      rw.runtimeInfo = (await rw.call(
        {
          type: "init",
          payload: {
            config: {
              ...creds,
              model: bundle.manifest.model as MossModelId,
              indexes: [pb, gt],
              wasmUrl: RUNTIME_URLS.mossWasm,
              onnxWasmPath: RUNTIME_URLS.ortDir,
              ortThreads: opts.ortThreads,
            },
            docVectors: { [pb]: bundle.embeddings.indexes.playbooks, [gt]: bundle.embeddings.indexes.ground_truth },
          },
        },
        180_000,
      )) as RuntimeInfo;
      return rw;
    } catch (err) {
      rw.terminate();
      throw err;
    }
  }

  async query(index: string, text: string, opts: QueryOptions): Promise<ClientQueryResult> {
    const t0 = performance.now();
    const r = (await this.call({ type: "query", payload: { index, text, opts } })) as QueryResult;
    return { ...r, roundTripMs: performance.now() - t0, networkMs: 0 };
  }

  terminate(): void {
    this.worker.terminate();
    this.failAll(new Error("retrieval worker terminated"));
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private call(body: RequestBody, timeoutMs = 0): Promise<WorkerResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`retrieval worker timed out after ${timeoutMs / 1000}s`));
          }, timeoutMs)
        : undefined;
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.worker.postMessage({ ...body, id } as WorkerRequest);
    });
  }
}
