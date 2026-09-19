import type { FixtureCall } from "@/corpus/schema";
import { clock } from "@/lib/evidence/pack";

const W = 640;
const H = 74;
const PAD = 8;

export function CallTimeline({ call, warningAt, results }: { call: FixtureCall; warningAt: number | null; results: { resolvedAt: number; signal: boolean }[] }) {
  const duration = Math.max(call.turns.at(-1)!.end, warningAt ?? 0) + 1;
  const x = (t: number) => PAD + (t / duration) * (W - PAD * 2);
  const onset = call.onsetTurn === null ? null : call.turns[call.onsetTurn]!.start;
  const extraction = call.extractionTurn === null ? null : call.turns[call.extractionTurn]!.start;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Call timeline with warning and extraction markers">
      {call.turns.map((t, i) => (
        <rect key={i} x={x(t.start)} y={t.speaker === "caller" ? 14 : 26} width={Math.max(1, x(t.end) - x(t.start))} height={9} rx={2} fill={t.speaker === "caller" ? "var(--color-muted)" : "var(--color-line)"} opacity={t.speaker === "caller" ? 0.55 : 1} />
      ))}
      {results.map((r, i) => (
        <circle key={i} cx={x(r.resolvedAt)} cy={46} r={1.6} fill={r.signal ? "var(--color-danger)" : "var(--color-faint)"} />
      ))}
      {onset !== null && <line x1={x(onset)} x2={x(onset)} y1={8} y2={54} stroke="var(--color-warn)" strokeDasharray="3 2" />}
      {extraction !== null && (
        <g>
          <line x1={x(extraction)} x2={x(extraction)} y1={8} y2={54} stroke="var(--color-danger)" strokeWidth={1.4} />
          <text x={x(extraction) + 3} y={66} fontSize={9.5} fill="var(--color-danger)">
            extraction {clock(extraction)}
          </text>
        </g>
      )}
      {warningAt !== null && (
        <g>
          <path d={`M${x(warningAt)},4 l5,6 l-5,6 l-5,-6 z`} fill="var(--color-shield)" />
          <line x1={x(warningAt)} x2={x(warningAt)} y1={16} y2={54} stroke="var(--color-shield)" strokeWidth={1.6} />
          <text x={Math.max(PAD, x(warningAt) - 4)} y={66} textAnchor="end" fontSize={9.5} fill="var(--color-shield)">
            warning {warningAt.toFixed(1)}s
          </text>
        </g>
      )}
    </svg>
  );
}
