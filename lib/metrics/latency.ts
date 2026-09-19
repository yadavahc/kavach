/**
 * Latency summaries. Shared by the CLI verifier, the eval bench, and the app
 * header readout, so every surface reports percentiles the same way.
 */

export interface LatencySummary {
  n: number;
  min: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
  p999: number;
  max: number;
}

/** Nearest-rank percentile over an ascending-sorted array. p in [0, 100]. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function summarize(samples: readonly number[]): LatencySummary {
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  return {
    n,
    min: s[0] ?? Number.NaN,
    mean: n ? s.reduce((a, b) => a + b, 0) / n : Number.NaN,
    p50: percentile(s, 50),
    p90: percentile(s, 90),
    p99: percentile(s, 99),
    p999: percentile(s, 99.9),
    max: s[n - 1] ?? Number.NaN,
  };
}

/** Fixed-capacity ring buffer for rolling live percentiles. */
export class LatencyWindow {
  private readonly buf: Float64Array;
  private next = 0;
  private count = 0;

  constructor(capacity = 512) {
    this.buf = new Float64Array(capacity);
  }

  record(ms: number): void {
    this.buf[this.next] = ms;
    this.next = (this.next + 1) % this.buf.length;
    this.count = Math.min(this.count + 1, this.buf.length);
  }

  summary(): LatencySummary {
    return summarize(Array.from(this.buf.subarray(0, this.count)));
  }
}
