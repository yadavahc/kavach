/**
 * Drivers connect a transcript source and a retriever to the detection engine.
 *
 * Both run the same serialized pipeline: pending claim checks first, then one
 * playbook query for the rolling window, at most one retrieval in flight.
 *
 * - runSimulatedCall: fixture call in simulated call time. Retrieval latency
 *   (measured, plus any simulated network time) advances the clock, so two
 *   retrievers can be compared on the same call without sharing the device.
 * - RealtimeSession: wall-clock call for the live microphone or 1× playback.
 */
import type { FixtureCall } from "../../corpus/schema";
import type { CorpusBundle } from "../corpus/client-data";
import type { Retriever } from "../moss/client";
import { extractAssertions } from "./claims";
import { DETECTION, type DetectionConfig } from "./config";
import { DetectionEngine } from "./engine";
import { fixtureSegments, Transcript, type Segment } from "./transcript";

interface ClaimJob {
  text: string;
  segmentId: string;
}

/** What a simulated run needs: index names and the records to join hits to. */
export type SimulationBundle = Pick<CorpusBundle, "manifest" | "playbookById" | "groundTruthById">;

const wordCount = (s: string) => (s ? s.split(/\s+/).filter(Boolean).length : 0);

export interface SimulatedRunOptions {
  cfg?: DetectionConfig;
  signal?: AbortSignal;
  onProgress?: (callTime: number, engine: DetectionEngine) => void;
}

export interface SimulatedRunResult {
  engine: DetectionEngine;
  transcript: Transcript;
  callEnd: number;
  wallMs: number;
  queries: number;
}

export async function runSimulatedCall(call: FixtureCall, retriever: Retriever, bundle: SimulationBundle, opts: SimulatedRunOptions = {}): Promise<SimulatedRunResult> {
  const cfg = opts.cfg ?? DETECTION;
  const transcript = new Transcript();
  for (const seg of fixtureSegments(call)) transcript.upsert(seg);
  const engine = new DetectionEngine(bundle, cfg);
  const pb = bundle.manifest.indexes.playbooks.name;
  const gt = bundle.manifest.indexes.ground_truth.name;
  const segs = transcript.segments;
  const callEnd = segs.at(-1)!.end;
  const tick = cfg.tickMs / 1000;
  const claims: ClaimJob[] = [];
  const wall0 = performance.now();
  let nextSeg = 0;
  let lastWindow = "";
  let queries = 0;
  let t = 0;

  while (t <= callEnd + tick) {
    opts.signal?.throwIfAborted();
    while (nextSeg < segs.length && segs[nextSeg]!.end <= t) {
      const s = segs[nextSeg++]!;
      if (s.speaker !== "callee") for (const text of extractAssertions(s.text)) claims.push({ text, segmentId: s.id });
    }
    for (let job = claims.shift(); job; job = claims.shift()) {
      const r = await retriever.query(gt, job.text, { topK: cfg.claimTopK, alpha: cfg.alpha });
      queries++;
      const resolvedAt = t + r.roundTripMs / 1000;
      engine.applyClaim(t, resolvedAt, job.text, job.segmentId, r);
      t = resolvedAt;
    }
    const window = transcript.window(t, cfg.windowSeconds);
    if (wordCount(window) >= cfg.minWindowWords && window !== lastWindow) {
      const issued = t;
      const r = await retriever.query(pb, window, { topK: cfg.topK, alpha: cfg.alpha });
      queries++;
      const resolvedAt = issued + r.roundTripMs / 1000;
      engine.applyTick(issued, resolvedAt, window, r);
      lastWindow = window;
      t = Math.max(issued + tick, resolvedAt);
    } else {
      t += tick;
    }
    opts.onProgress?.(t, engine);
  }

  return { engine, transcript, callEnd, wallMs: performance.now() - wall0, queries };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RealtimeSession {
  readonly transcript = new Transcript();
  readonly engine: DetectionEngine;
  private readonly claimQueue: ClaimJob[] = [];
  private readonly claimed = new Set<string>();
  private readonly transcriptListeners = new Set<() => void>();
  private startedAt = 0;
  private running = false;
  private stopAt = Infinity;

  constructor(
    private readonly bundle: CorpusBundle,
    private readonly retriever: Retriever,
    private readonly cfg: DetectionConfig = DETECTION,
    private readonly onError: (err: unknown) => void = console.error,
  ) {
    this.engine = new DetectionEngine(bundle, cfg);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Seconds since the call started. */
  now(): number {
    return this.running || this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  onTranscript(fn: () => void): () => void {
    this.transcriptListeners.add(fn);
    return () => this.transcriptListeners.delete(fn);
  }

  start(): void {
    if (this.running) return;
    this.startedAt = performance.now();
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  /** Adds or revises a segment. Final caller-side segments are queued for claim checking. */
  pushSegment(seg: Segment): void {
    this.transcript.upsert(seg);
    if (seg.final && seg.speaker !== "callee" && !this.claimed.has(seg.id)) {
      this.claimed.add(seg.id);
      for (const text of extractAssertions(seg.text)) this.claimQueue.push({ text, segmentId: seg.id });
    }
    for (const fn of this.transcriptListeners) fn();
  }

  /** Plays a fixture call at 1× against the wall clock. */
  playFixture(call: FixtureCall): void {
    const segments = fixtureSegments(call);
    for (const seg of segments) this.transcript.upsert({ ...seg, final: false });
    this.stopAt = segments.at(-1)!.end + 1.5;
    this.start();
    const pending = [...segments];
    const finaliser = async () => {
      while (this.running && pending.length) {
        const next = pending[0]!;
        const wait = next.end - this.now();
        if (wait > 0) await sleep(Math.min(wait * 1000, 250));
        else this.pushSegment(pending.shift()!);
      }
    };
    void finaliser();
  }

  private async loop(): Promise<void> {
    const pb = this.bundle.manifest.indexes.playbooks.name;
    const gt = this.bundle.manifest.indexes.ground_truth.name;
    let lastWindow = "";
    while (this.running) {
      const tickStart = performance.now();
      try {
        for (let job = this.claimQueue.shift(); job && this.running; job = this.claimQueue.shift()) {
          const at = this.now();
          const r = await this.retriever.query(gt, job.text, { topK: this.cfg.claimTopK, alpha: this.cfg.alpha });
          this.engine.applyClaim(at, this.now(), job.text, job.segmentId, r);
        }
        const at = this.now();
        const window = this.transcript.window(at, this.cfg.windowSeconds);
        if (this.running && wordCount(window) >= this.cfg.minWindowWords && window !== lastWindow) {
          const r = await this.retriever.query(pb, window, { topK: this.cfg.topK, alpha: this.cfg.alpha });
          this.engine.applyTick(at, this.now(), window, r);
          lastWindow = window;
        }
      } catch (err) {
        this.onError(err);
      }
      if (this.now() >= this.stopAt) {
        this.running = false;
        for (const fn of this.transcriptListeners) fn();
        break;
      }
      await sleep(Math.max(0, this.cfg.tickMs - (performance.now() - tickStart)));
    }
  }
}
