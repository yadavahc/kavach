"use client";

import { useEffect, useRef } from "react";
import { DETECTION } from "@/lib/detection/config";
import type { Segment } from "@/lib/detection/transcript";
import { clock } from "@/lib/evidence/pack";
import { Empty } from "../ui";

const SPEAKER: Record<Segment["speaker"], string> = { caller: "Caller", callee: "You", unknown: "Call audio" };

export function TranscriptView({ lines, now }: { lines: { segment: Segment; text: string; complete: boolean }[]; now: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  const shownWords = lines.reduce((n, l) => n + l.text.length, 0);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, shownWords]);

  const visible = lines.filter((l) => l.text);
  if (!visible.length) return <Empty>Transcript appears here as the call is heard.</Empty>;

  return (
    <div ref={scroller} className="max-h-[420px] min-h-[200px] overflow-y-auto pr-1">
      <ol className="flex flex-col gap-2.5">
        {visible.map(({ segment, text, complete }) => {
          const inWindow = segment.end > now - DETECTION.windowSeconds;
          return (
            <li key={segment.id} className={`rounded-lg border-l-2 pl-3 transition-colors ${inWindow ? "border-accent" : "border-line"}`}>
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-faint">
                <span className={segment.speaker === "callee" ? "text-muted" : "text-fg/70"}>{SPEAKER[segment.speaker]}</span>
                <span className="tabular font-mono normal-case tracking-normal">{clock(segment.start)}</span>
              </div>
              <p className={`text-[14px] leading-relaxed ${segment.speaker === "callee" ? "text-muted" : "text-fg"}`}>
                {text}
                {!complete && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-accent/80" />}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
