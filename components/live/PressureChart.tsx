import { STAGE_LABELS } from "@/corpus/taxonomy";
import type { PressurePoint, StageEvent } from "@/lib/detection/engine";
import { clock } from "@/lib/evidence/pack";

const W = 600;
const H = 170;
const PAD = { l: 28, r: 8, t: 12, b: 20 };

const SERIES = [
  { key: "urgency", label: "Urgency", color: "var(--color-warn)" },
  { key: "isolation", label: "Isolation", color: "var(--color-accent)" },
  { key: "secrecy", label: "Secrecy", color: "var(--color-shield)" },
  { key: "authority", label: "Authority", color: "var(--color-muted)" },
] as const;

export function PressureChart({ points, now, warningAt, stages }: { points: PressurePoint[]; now: number; warningAt: number | null; stages: StageEvent[] }) {
  const duration = Math.max(20, now, points.at(-1)?.t ?? 0);
  const x = (t: number) => PAD.l + (t / duration) * (W - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - Math.min(1, Math.max(0, v)) * (H - PAD.t - PAD.b);
  const path = (get: (p: PressurePoint) => number) => points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(get(p)).toFixed(1)}`).join(" ");
  const latest = points.at(-1);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="tabular font-mono text-3xl font-semibold text-fg">
          {latest ? Math.round(latest.composite * 100) : 0}
          <span className="ml-1 text-sm font-normal text-muted">/ 100</span>
        </div>
        <div className="flex flex-wrap gap-3 text-[11px] text-muted">
          {SERIES.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded" style={{ background: s.color }} />
              {s.label} {latest ? Math.round(latest.signals[s.key] * 100) : 0}
            </span>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Coercion pressure over call time">
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--color-line)" strokeWidth={1} />
            <text x={PAD.l - 6} y={y(v) + 3} textAnchor="end" fontSize={9} fill="var(--color-faint)">
              {v * 100}
            </text>
          </g>
        ))}
        {stages.map((s) => (
          <g key={s.stage}>
            <line x1={x(s.at)} x2={x(s.at)} y1={PAD.t} y2={H - PAD.b} stroke="var(--color-line)" strokeDasharray="2 3" />
            <text x={x(s.at) + 3} y={PAD.t + 8} fontSize={8.5} fill="var(--color-faint)">
              {STAGE_LABELS[s.stage]}
            </text>
          </g>
        ))}
        {SERIES.map((s) => (
          <path key={s.key} d={path((p) => p.signals[s.key])} fill="none" stroke={s.color} strokeWidth={1.2} strokeOpacity={0.7} />
        ))}
        <path d={path((p) => p.composite)} fill="none" stroke="var(--color-danger)" strokeWidth={2.4} strokeLinejoin="round" />
        {warningAt !== null && (
          <g>
            <line x1={x(warningAt)} x2={x(warningAt)} y1={PAD.t} y2={H - PAD.b} stroke="var(--color-danger)" strokeWidth={1.2} />
            <text x={Math.min(x(warningAt) + 4, W - 70)} y={H - PAD.b - 6} fontSize={9.5} fill="var(--color-danger)">
              warning {clock(warningAt)}
            </text>
          </g>
        )}
        <text x={PAD.l} y={H - 5} fontSize={9} fill="var(--color-faint)">
          0:00
        </text>
        <text x={W - PAD.r} y={H - 5} textAnchor="end" fontSize={9} fill="var(--color-faint)">
          {clock(duration)}
        </text>
      </svg>
    </div>
  );
}
