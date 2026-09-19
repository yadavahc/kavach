import type { ReactNode } from "react";

export type Tone = "neutral" | "danger" | "warn" | "ok" | "accent";

const CHIP: Record<Tone, string> = {
  neutral: "border-line bg-panel-2 text-muted",
  danger: "border-danger/40 bg-danger/10 text-danger",
  warn: "border-warn/40 bg-warn/10 text-warn",
  ok: "border-ok/40 bg-ok/10 text-ok",
  accent: "border-accent/40 bg-accent/10 text-accent",
};

const BAR: Record<Tone, string> = {
  neutral: "bg-muted",
  danger: "bg-danger",
  warn: "bg-warn",
  ok: "bg-ok",
  accent: "bg-accent",
};

export function Panel({ title, right, children, className = "" }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel flex min-w-0 flex-col p-4 ${className}`}>
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

export function Chip({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${CHIP[tone]}`}>
      {children}
    </span>
  );
}

export function Meter({ value, tone = "accent", className = "" }: { value: number; tone?: Tone; className?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-line ${className}`}>
      <div className={`h-full rounded-full transition-[width] duration-300 ${BAR[tone]}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Stat({ label, value, unit, hint }: { label: string; value: ReactNode; unit?: string; hint?: string }) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="text-[10px] uppercase tracking-[0.14em] text-faint">{label}</div>
      <div className="tabular font-mono text-sm text-fg">
        {value}
        {unit && <span className="ml-0.5 text-[11px] text-muted">{unit}</span>}
      </div>
    </div>
  );
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "–";
  return ms < 1 ? ms.toFixed(2) : ms < 10 ? ms.toFixed(1) : Math.round(ms).toString();
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-faint">{children}</p>;
}
