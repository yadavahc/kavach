"use client";

import { useEffect, useState } from "react";
import { loadCorpusBundle, type CorpusBundle } from "@/lib/corpus/client-data";
import { fetchMossCredentials, RetrievalWorker } from "@/lib/moss/client";

export type RetrievalBoot =
  | { state: "loading"; step: string }
  | { state: "ready"; bundle: CorpusBundle; worker: RetrievalWorker }
  | { state: "error"; message: string };

/** Loads the corpus artifacts and starts the on-device retrieval worker for this page. */
export function useRetrieval(): RetrievalBoot {
  const [boot, setBoot] = useState<RetrievalBoot>({ state: "loading", step: "Loading corpus" });

  useEffect(() => {
    let cancelled = false;
    let worker: RetrievalWorker | null = null;
    (async () => {
      try {
        const bundle = await loadCorpusBundle();
        if (cancelled) return;
        setBoot({ state: "loading", step: "Starting on-device retrieval (Moss WASM index + ONNX embedder)" });
        worker = await RetrievalWorker.start(bundle, await fetchMossCredentials());
        if (cancelled) return worker.terminate();
        setBoot({ state: "ready", bundle, worker });
      } catch (err) {
        if (!cancelled) setBoot({ state: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
      worker?.terminate();
    };
  }, []);

  return boot;
}
