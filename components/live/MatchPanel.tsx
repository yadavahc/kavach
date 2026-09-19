import { FAMILY_LABELS, STAGE_LABELS } from "@/corpus/taxonomy";
import type { CorpusBundle } from "@/lib/corpus/client-data";
import { DETECTION } from "@/lib/detection/config";
import type { TickRecord } from "@/lib/detection/engine";
import { clock } from "@/lib/evidence/pack";
import { Chip, Empty, Meter, fmtMs } from "../ui";

export function MatchPanel({ tick, bundle, streak, stagesMatched }: { tick: TickRecord | null; bundle: CorpusBundle; streak: number; stagesMatched: number }) {
  if (!tick) return <Empty>Waiting for the first {DETECTION.minWindowWords} words of speech…</Empty>;
  const a = tick.assessment;
  const lead = a.bestScam ? bundle.playbookById.get(a.bestScam.id) : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="rounded-lg border border-line bg-panel-2 p-3">
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-faint">
          <span>Query window · last {DETECTION.windowSeconds}s at {clock(tick.at)}</span>
          <span className="tabular font-mono normal-case tracking-normal">
            {fmtMs(tick.latency.roundTripMs)} ms
          </span>
        </div>
        <p className="line-clamp-3 font-mono text-[12.5px] leading-relaxed text-fg/90">“{tick.window}”</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {a.scamSignal ? <Chip tone="danger">Scam pattern · {FAMILY_LABELS[a.bestScam!.family]}</Chip> : <Chip tone="ok">No scam signal</Chip>}
        {a.scamSignal && a.stage !== "none" && <Chip tone="warn">{STAGE_LABELS[a.stage]}</Chip>}
        <Chip title="Consecutive results naming the same scam family; the warning needs this many">
          streak {streak}/{DETECTION.warnConsecutive}
        </Chip>
        <Chip title="Distinct script stages this family has matched; the warning needs this many">
          stages {stagesMatched}/{DETECTION.minDistinctStages}
        </Chip>
        <Chip title="Best scam match minus best benign match">margin {a.margin > -1 ? a.margin.toFixed(2) : "–"}</Chip>
      </div>

      <ul className="flex flex-col gap-2">
        {tick.hits.map((h) => {
          const e = bundle.playbookById.get(h.id);
          if (!e) return null;
          const benign = e.family === "benign";
          return (
            <li key={h.id} className="rounded-lg border border-line/70 p-2.5">
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                <Chip tone={benign ? "ok" : "danger"}>{FAMILY_LABELS[e.family]}</Chip>
                {e.stage !== "none" && <Chip>{STAGE_LABELS[e.stage]}</Chip>}
                <span className="ml-auto tabular font-mono text-[11px] text-muted" title="Moss rank · cosine similarity">
                  #{h.rank} · {h.cosine.toFixed(3)}
                </span>
              </div>
              <Meter value={(h.cosine - DETECTION.cosineFloor) / (1 - DETECTION.cosineFloor)} tone={benign ? "ok" : h.cosine >= DETECTION.scamMin ? "danger" : "neutral"} />
              <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-snug text-muted">{e.text}</p>
            </li>
          );
        })}
      </ul>

      {a.scamSignal && lead && (
        <p className="rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-[12.5px] leading-snug text-fg/90">
          <span className="font-semibold text-danger">Why it matters: </span>
          {lead.tell}
        </p>
      )}
    </div>
  );
}
