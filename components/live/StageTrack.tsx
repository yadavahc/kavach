import { STAGES, STAGE_LABELS } from "@/corpus/taxonomy";
import type { StageEvent } from "@/lib/detection/engine";
import { clock } from "@/lib/evidence/pack";

export function StageTrack({ stages }: { stages: StageEvent[] }) {
  const reached = new Map(stages.map((s) => [s.stage, s]));
  const current = stages.at(-1)?.stage;
  return (
    <ol className="grid grid-cols-5 gap-1.5">
      {STAGES.map((stage, i) => {
        const hit = reached.get(stage);
        const isCurrent = stage === current;
        return (
          <li key={stage} className="min-w-0">
            <div className={`h-1.5 rounded-full ${hit ? (isCurrent ? "bg-danger" : "bg-danger/50") : "bg-line"}`} />
            <div className={`mt-1.5 truncate text-[11px] ${hit ? "text-fg" : "text-faint"}`}>
              {i + 1}. {STAGE_LABELS[stage]}
            </div>
            <div className="tabular font-mono text-[10px] text-muted">{hit ? clock(hit.at) : "–"}</div>
          </li>
        );
      })}
    </ol>
  );
}
