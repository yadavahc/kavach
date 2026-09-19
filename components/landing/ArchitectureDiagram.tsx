"use client";

import { useState } from "react";

export interface ArchNode {
  id: string;
  label: string;
  detail: string;
  /** Measured contribution, or null where the step is not on the hot path. */
  metric: string | null;
  metricNote: string;
  where: "device" | "server";
  x: number;
  y: number;
  w: number;
}

export interface ArchEdge {
  from: string;
  to: string;
  dashed?: boolean;
}

const W = 980;
const H = 430;
const NODE_H = 54;

export function ArchitectureDiagram({ nodes, edges, source }: { nodes: ArchNode[]; edges: ArchEdge[]; source: string }) {
  const [active, setActive] = useState<string | null>(null);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const current = active ? byId.get(active) : undefined;

  const anchor = (n: ArchNode, side: "in" | "out") => ({ x: side === "in" ? n.x : n.x + n.w, y: n.y + NODE_H / 2 });

  return (
    <div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[720px]" role="img" aria-label="Kavach architecture: on-device detection loop and thin server">
          <rect x={8} y={8} width={W - 16} height={250} rx={14} fill="none" stroke="var(--color-line)" />
          <text x={22} y={30} fontSize={11} fill="var(--color-faint)" letterSpacing="1.6">
            ON DEVICE · AUDIO AND TRANSCRIPT NEVER LEAVE THE BROWSER
          </text>
          <rect x={8} y={270} width={W - 16} height={152} rx={14} fill="none" stroke="var(--color-line)" strokeDasharray="4 4" />
          <text x={22} y={292} fontSize={11} fill="var(--color-faint)" letterSpacing="1.6">
            SERVER · BUILD TIME AND OFF THE HOT PATH
          </text>

          {edges.map((e) => {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (!a || !b) return null;
            const lit = active === e.from || active === e.to;
            let d: string;
            if (b.x >= a.x + a.w - 1) {
              // Left to right: out of the right edge, into the left edge.
              const p1 = anchor(a, "out");
              const p2 = anchor(b, "in");
              const mid = (p1.x + p2.x) / 2;
              d = `M${p1.x},${p1.y} C${mid},${p1.y} ${mid},${p2.y} ${p2.x},${p2.y}`;
            } else if (b.x + b.w <= a.x + 1) {
              // Right to left on the same band: out of the left edge, into the right edge.
              const p1 = { x: a.x, y: a.y + NODE_H / 2 };
              const p2 = { x: b.x + b.w, y: b.y + NODE_H / 2 };
              const mid = (p1.x + p2.x) / 2;
              d = `M${p1.x},${p1.y} C${mid},${p1.y} ${mid},${p2.y} ${p2.x},${p2.y}`;
            } else {
              // Overlapping columns: vertical connector between the nearer edges.
              const x = (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2;
              const down = b.y > a.y;
              const y1 = down ? a.y + NODE_H : a.y;
              const y2 = down ? b.y : b.y + NODE_H;
              d = `M${x},${y1} L${x},${y2}`;
            }
            return (
              <path
                key={`${e.from}-${e.to}`}
                d={d}
                fill="none"
                stroke={lit ? "var(--color-accent)" : "var(--color-line)"}
                strokeWidth={lit ? 2 : 1.4}
                strokeDasharray={e.dashed ? "5 4" : undefined}
              />
            );
          })}

          {nodes.map((n) => {
            const lit = active === n.id;
            return (
              <g
                key={n.id}
                tabIndex={0}
                role="button"
                aria-label={`${n.label}. ${n.detail}`}
                onMouseEnter={() => setActive(n.id)}
                onMouseLeave={() => setActive((cur) => (cur === n.id ? null : cur))}
                onFocus={() => setActive(n.id)}
                onBlur={() => setActive((cur) => (cur === n.id ? null : cur))}
                className="cursor-pointer outline-none"
              >
                <rect
                  x={n.x}
                  y={n.y}
                  width={n.w}
                  height={NODE_H}
                  rx={10}
                  fill={lit ? "var(--color-panel-2)" : "var(--color-panel)"}
                  stroke={lit ? "var(--color-accent)" : n.where === "server" ? "var(--color-line)" : "var(--color-line)"}
                  strokeWidth={lit ? 2 : 1.2}
                />
                <text x={n.x + 12} y={n.y + 22} fontSize={12.5} fill="var(--color-fg)">
                  {n.label}
                </text>
                <text x={n.x + 12} y={n.y + 40} fontSize={11} fill={n.metric ? "var(--color-shield)" : "var(--color-faint)"} className="tabular">
                  {n.metric ?? "not on hot path"}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mt-3 min-h-[68px] rounded-xl border border-line bg-panel-2 p-3">
        {current ? (
          <>
            <div className="text-[13px] font-medium text-fg">{current.label}</div>
            <p className="mt-0.5 text-[12.5px] leading-snug text-muted">{current.detail}</p>
            <p className="mt-1 text-[12px] text-shield">
              {current.metric ? `${current.metric} — ${current.metricNote}` : current.metricNote}
            </p>
          </>
        ) : (
          <p className="text-[12.5px] text-muted">Hover or focus a step to see what it contributes to the loop. {source}</p>
        )}
      </div>
    </div>
  );
}
