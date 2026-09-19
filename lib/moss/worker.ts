/**
 * Retrieval Web Worker: keeps ONNX embedding and Moss search off the UI thread.
 * Requests are serialized because an ONNX inference session must not run
 * concurrently with itself.
 */
import { cosine, decodeVectors } from "../detection/vectors";
import type { QueryResult, RetrievedHit, WorkerRequest, WorkerResponse, WorkerResult } from "./protocol";
import { MossRuntime } from "./runtime";

interface WorkerScope {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: WorkerResponse): void;
}

const scope = self as unknown as WorkerScope;
const vectors = new Map<string, Map<string, Float32Array>>();
let runtime: MossRuntime | null = null;
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn);
  queue = next.catch(() => undefined);
  return next;
}

async function handle(req: WorkerRequest): Promise<WorkerResult> {
  if (req.type === "init") {
    for (const [index, enc] of Object.entries(req.payload.docVectors)) vectors.set(index, decodeVectors(enc));
    runtime?.dispose();
    runtime = await MossRuntime.create(req.payload.config);
    return runtime.info;
  }

  if (!runtime) throw new Error("retrieval runtime not initialised");
  const { index, text, opts } = req.payload;
  const q = await runtime.query(index, text, opts);
  const docVecs = vectors.get(index);
  const t = performance.now();
  const hits: RetrievedHit[] = q.hits
    .map((h, i) => {
      const v = docVecs?.get(h.id);
      return { id: h.id, score: h.score, rank: i + 1, cosine: v ? cosine(q.embedding, v) : 0 };
    })
    .sort((a, b) => b.cosine - a.cosine);
  const rescoreMs = performance.now() - t;
  const result: QueryResult = { hits, embedMs: q.embedMs, searchMs: q.searchMs, rescoreMs, totalMs: q.totalMs + rescoreMs };
  return result;
}

scope.onmessage = (ev) => {
  const req = ev.data;
  serial(() => handle(req)).then(
    (result) => scope.postMessage({ id: req.id, ok: true, result }),
    (err: unknown) => scope.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
};
