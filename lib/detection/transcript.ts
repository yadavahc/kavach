/**
 * Call transcript with word-level timing. Word times are interpolated linearly
 * across each segment, which works for both sources: fixture turns carry
 * start/end times, and live speech segments are stamped as results arrive.
 */
import type { FixtureCall } from "../../corpus/schema";

export type Speaker = "caller" | "callee" | "unknown";

export interface Segment {
  id: string;
  speaker: Speaker;
  /** Call time in seconds. */
  start: number;
  end: number;
  text: string;
  /** false while live speech recognition may still revise the segment. */
  final: boolean;
}

const splitWords = (s: string) => s.split(/\s+/).filter(Boolean);

export class Transcript {
  private segs: Segment[] = [];

  get segments(): readonly Segment[] {
    return this.segs;
  }

  upsert(seg: Segment): void {
    const i = this.segs.findIndex((s) => s.id === seg.id);
    if (i >= 0) this.segs[i] = seg;
    else this.segs.push(seg);
  }

  clear(): void {
    this.segs = [];
  }

  /** Words spoken in (from, to]. */
  wordsBetween(from: number, to: number): string[] {
    const out: string[] = [];
    for (const s of this.segs) {
      if (s.start > to || s.end <= from) continue;
      const words = splitWords(s.text);
      const dur = Math.max(1e-3, s.end - s.start);
      words.forEach((w, i) => {
        const t = s.start + (dur * (i + 1)) / words.length;
        if (t > from && t <= to) out.push(w);
      });
    }
    return out;
  }

  /** The rolling retrieval window ending at call time `at`. */
  window(at: number, seconds: number): string {
    return this.wordsBetween(at - seconds, at).join(" ");
  }

  /** Each segment's text as revealed by call time `at` (drives the typing view). */
  revealed(at: number): { segment: Segment; text: string; complete: boolean }[] {
    return this.segs
      .filter((s) => s.start <= at)
      .map((s) => {
        const words = splitWords(s.text);
        const dur = Math.max(1e-3, s.end - s.start);
        const shown = Math.min(words.length, Math.floor(((at - s.start) / dur) * words.length + 1e-9));
        return { segment: s, text: words.slice(0, Math.max(0, shown)).join(" "), complete: at >= s.end };
      });
  }
}

export function fixtureSegments(call: FixtureCall): Segment[] {
  return call.turns.map((t, i) => ({ id: `${call.id}#${i}`, speaker: t.speaker, start: t.start, end: t.end, text: t.text, final: true }));
}
