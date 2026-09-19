/**
 * Arm B of the latency A/B: the same Moss retrieval, the same query embedding
 * on this device, plus simulated network round trips to a hosted vector DB.
 * Local embedding is kept in both arms, which is conservative for the hosted
 * arm (a hosted service would also add server-side embedding or search time).
 * Only the network delay is simulated; everything else is measured.
 */
import type { ClientQueryResult, Retriever } from "./client";
import type { QueryOptions } from "./runtime";

export interface NetworkProfile {
  id: string;
  label: string;
  /** Median round-trip time per query. */
  medianRttMs: number;
  /** Log-normal shape: larger values give heavier tails. */
  sigma: number;
}

export const NETWORK_PROFILES: NetworkProfile[] = [
  { id: "same-region", label: "Same-region cloud", medianRttMs: 80, sigma: 0.3 },
  { id: "cross-region", label: "Cross-region cloud", medianRttMs: 180, sigma: 0.4 },
  { id: "mobile", label: "Mobile network", medianRttMs: 300, sigma: 0.6 },
];

/** Small seeded PRNG so a given A/B run is reproducible. */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SimulatedHostedRetriever implements Retriever {
  readonly label: string;
  private readonly random: () => number;

  /**
   * @param realtime true: actually wait for the network delay (live playback).
   *                 false: add it to the reported latency only (simulated call time).
   */
  constructor(
    private readonly inner: Retriever,
    readonly profile: NetworkProfile,
    seed = 42,
    private readonly realtime = false,
  ) {
    this.label = `Simulated hosted DB · ${profile.label} (${profile.medianRttMs} ms median RTT)`;
    this.random = mulberry32(seed);
  }

  private sampleRttMs(): number {
    const u1 = Math.max(this.random(), 1e-12);
    const u2 = this.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return this.profile.medianRttMs * Math.exp(this.profile.sigma * z);
  }

  async query(index: string, text: string, opts: QueryOptions): Promise<ClientQueryResult> {
    const networkMs = this.sampleRttMs();
    if (!this.realtime) {
      const r = await this.inner.query(index, text, opts);
      return { ...r, networkMs, roundTripMs: r.roundTripMs + networkMs };
    }
    const t0 = performance.now();
    await sleep(networkMs / 2);
    const r = await this.inner.query(index, text, opts);
    await sleep(networkMs / 2);
    return { ...r, networkMs, roundTripMs: performance.now() - t0 };
  }
}
