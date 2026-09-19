import type { TickRecord } from "@/lib/detection/engine";
import { summarize } from "@/lib/metrics/latency";
import type { RuntimeInfo } from "@/lib/moss/runtime";
import { Chip, Stat, fmtMs } from "../ui";

const RECENT = 60;

/** Live readout of measured retrieval latency. Every number comes from the last queries on this device. */
export function LatencyHeader({ ticks, info }: { ticks: TickRecord[]; info: RuntimeInfo | null }) {
  const recent = ticks.slice(-RECENT);
  const pick = (f: (t: TickRecord) => number) => (recent.length ? summarize(recent.map(f)) : null);
  const search = pick((t) => t.latency.searchMs);
  const embed = pick((t) => t.latency.embedMs);
  const rescore = pick((t) => t.latency.rescoreMs);
  const round = pick((t) => t.latency.roundTripMs);

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      <Stat label="Moss search p50" value={fmtMs(search?.p50)} unit="ms" hint="In-browser WASM search, median of recent queries" />
      <Stat label="search p99" value={fmtMs(search?.p99)} unit="ms" />
      <Stat label="embed p50" value={fmtMs(embed?.p50)} unit="ms" hint="On-device ONNX query embedding" />
      <Stat label="re-score p50" value={fmtMs(rescore?.p50)} unit="ms" hint="Cosine re-scoring of Moss's top-k" />
      <Stat label="round trip p50" value={fmtMs(round?.p50)} unit="ms" hint="Main thread → worker → main thread" />
      <Stat label="queries" value={ticks.length} />
      {info && (
        <div className="flex flex-wrap gap-1.5">
          <Chip tone={info.crossOriginIsolated ? "ok" : "warn"} title="Cross-origin isolation enables precise timers and ONNX threads">
            {info.crossOriginIsolated ? "isolated" : "not isolated"}
          </Chip>
          <Chip title="ONNX Runtime WASM threads">ORT ×{info.ortNumThreads ?? 1}</Chip>
          <Chip title="performance.now() resolution">timer {(info.timerResolutionMs * 1000).toFixed(0)}µs</Chip>
        </div>
      )}
    </div>
  );
}
