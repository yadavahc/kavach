"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

/**
 * Scripted animation of one interception, 18 seconds long. It is a rehearsal
 * of the real interaction, not a recording of it: the transcript, scores and
 * timings below are fixed values chosen to illustrate the sequence. The live
 * app measures everything for real.
 */
interface Line {
  at: number;
  speaker: "caller" | "callee";
  text: string;
}

const SCRIPT: Line[] = [
  { at: 0.4, speaker: "caller", text: "Madam, this is Sub-Inspector Rathore from the cyber cell." },
  { at: 4.2, speaker: "caller", text: "Your Aadhaar is linked to a money laundering case." },
  { at: 8.0, speaker: "caller", text: "From this moment you are under digital arrest. Do not tell anyone." },
  { at: 13.4, speaker: "callee", text: "I'll verify this with my local police station myself." },
];

const MATCHES = [
  { at: 5.0, id: "pb.digital_arrest.authority_claim.02", label: "Digital arrest · authority claim", cosine: 0.61 },
  { at: 9.1, id: "pb.digital_arrest.isolation.01", label: "Digital arrest · isolation", cosine: 0.78 },
];

const WARNING_AT = 12.0;
const DURATION = 18;
const TICK = 0.3;

const clock = (t: number) => `0:${Math.floor(Math.max(0, t)).toString().padStart(2, "0")}`;

export function DemoTimeline() {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setT(DURATION);
      return;
    }
    const io = new IntersectionObserver((entries) => setPlaying(entries.some((e) => e.isIntersecting)), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((prev) => (prev + dt > DURATION + 2.5 ? 0 : prev + dt));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const warned = t >= WARNING_AT;
  const match = [...MATCHES].reverse().find((m) => t >= m.at);
  const ticks = Math.floor(Math.min(t, DURATION) / TICK);

  return (
    <div ref={host}>
      <Link
        href="/live"
        className="group block rounded-[18px] border border-line bg-panel p-4 transition-colors hover:border-accent/60 sm:p-5"
        aria-label="Scripted demo of an interception. Open the live app."
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Scripted demo · one call, 18 seconds</span>
          <span className="tabular font-mono text-[12px] text-muted">
            {clock(t)} · {ticks} retrieval queries
          </span>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.25fr_1fr]">
          <div className="min-h-[188px] rounded-xl border border-line/70 bg-ink p-3">
            <ol className="flex flex-col gap-2">
              {SCRIPT.filter((l) => t >= l.at).map((l) => {
                const chars = Math.max(0, Math.round(((t - l.at) / 2.6) * l.text.length));
                return (
                  <li key={l.at} className="text-[13.5px] leading-snug">
                    <span className="mr-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-faint">{l.speaker === "caller" ? "Caller" : "You"}</span>
                    <span className={l.speaker === "caller" ? "text-fg" : "text-ok"}>{l.text.slice(0, chars)}</span>
                    {chars < l.text.length && <span className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 bg-accent/80" />}
                  </li>
                );
              })}
            </ol>
          </div>

          <div className="flex flex-col gap-2.5">
            <div className="rounded-xl border border-line/70 p-3">
              <div className="text-[10px] uppercase tracking-[0.14em] text-faint">Matched playbook</div>
              {match ? (
                <>
                  <div className="mt-1 text-[13px] text-fg">{match.label}</div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-line">
                    <div className="h-full rounded-full bg-danger transition-[width] duration-500" style={{ width: `${match.cosine * 100}%` }} />
                  </div>
                  <div className="tabular mt-1 font-mono text-[11px] text-muted">similarity {match.cosine.toFixed(2)}</div>
                </>
              ) : (
                <div className="mt-1 text-[13px] text-muted">listening…</div>
              )}
            </div>

            <div className={`rounded-xl border p-3 transition-colors ${warned ? "border-danger/60 bg-danger/10" : "border-line/70"}`}>
              {warned ? (
                <>
                  <div className="text-[10px] uppercase tracking-[0.14em] text-danger">Warning at 0:12 · say this</div>
                  <p className="mt-1 text-[14px] font-medium leading-snug text-fg">“I’ll verify this with my local police station myself and call back from there.”</p>
                </>
              ) : (
                <div className="text-[13px] text-muted">No scam script confirmed yet.</div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-accent/70" style={{ width: `${(Math.min(t, DURATION) / DURATION) * 100}%` }} />
        </div>
        <p className="mt-2 text-[11.5px] text-faint group-hover:text-muted">
          Scripted illustration with fixed numbers. Click to run the real pipeline, where every score and latency is measured on your device.
        </p>
      </Link>
    </div>
  );
}
