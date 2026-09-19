/**
 * Evidence pack for a cybercrime complaint, assembled entirely on the device:
 * timestamped transcript, matched scam patterns with similarity scores, claim
 * verdicts with sources, the coercion pressure curve, and a SHA-256 digest of
 * the canonical JSON so the exported file can be shown to be unmodified.
 */
import { FAMILY_LABELS, STAGE_LABELS, type Family, type Stage, type Verdict } from "../../corpus/taxonomy";
import type { CorpusBundle } from "../corpus/client-data";
import type { EngineSnapshot } from "../detection/engine";
import type { Segment } from "../detection/transcript";
import { summarize } from "../metrics/latency";
import type { RuntimeInfo } from "../moss/runtime";

export interface EvidenceIncident {
  reporterName: string;
  callerNumber: string;
  amountLost: string;
  notes: string;
}

export interface EvidencePack {
  schema: "kavach.evidence/v1";
  generatedAt: string;
  source: { mode: "live-microphone" | "fixture-replay"; fixtureId: string | null; speechRecognition: string };
  incident: EvidenceIncident;
  corpus: { version: string; model: string; playbooksIndex: string; groundTruthIndex: string };
  device: { userAgent: string; crossOriginIsolated: boolean; ortThreads: number | null; retrievalRoundTripMs: { n: number; p50: number; p99: number } };
  summary: {
    durationSeconds: number;
    warning: { at: number; family: Family; familyLabel: string; stage: Stage | "none"; entryId: string; cosine: number } | null;
    stagesReached: { stage: Stage; label: string; at: number; entryId: string; cosine: number }[];
    peakPressure: { value: number; at: number };
    claimCounts: Record<Verdict, number>;
  };
  transcript: { start: number; end: number; speaker: string; text: string }[];
  matches: { at: number; resolvedAt: number; family: Family; stage: Stage | "none"; entryId: string; cosine: number; entryText: string }[];
  claims: {
    at: number;
    text: string;
    verdict: Verdict;
    cosine: number;
    evidence: { id: string; fact: string; publisher: string; title: string; url: string } | null;
  }[];
  pressureCurve: { t: number; composite: number; urgency: number; isolation: number; secrecy: number; authority: number }[];
  reportingChannels: { region: string; name: string; url: string }[];
  integrity: { algorithm: "SHA-256"; digest: string; covers: string };
}

export const REPORTING_CHANNELS: EvidencePack["reportingChannels"] = [
  { region: "India", name: "National Cyber Crime Reporting Portal (helpline 1930)", url: "https://cybercrime.gov.in/" },
  { region: "India", name: "Sanchar Saathi: report suspected fraud calls (Chakshu)", url: "https://sancharsaathi.gov.in/" },
  { region: "United States", name: "FTC ReportFraud", url: "https://reportfraud.ftc.gov/" },
  { region: "United States", name: "FBI Internet Crime Complaint Center", url: "https://www.ic3.gov/" },
  { region: "United Kingdom", name: "Action Fraud", url: "https://www.actionfraud.police.uk/" },
];

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** JSON with object keys sorted at every level, so the digest does not depend on key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface EvidenceInputs {
  snapshot: EngineSnapshot;
  segments: readonly Segment[];
  bundle: CorpusBundle;
  source: EvidencePack["source"];
  incident: EvidenceIncident;
  runtime: RuntimeInfo | null;
  durationSeconds: number;
}

export async function buildEvidencePack(input: EvidenceInputs): Promise<EvidencePack> {
  const { snapshot: s, bundle } = input;
  const rt = s.ticks.map((t) => t.latency.roundTripMs);
  const rtSummary = summarize(rt);
  const peak = s.pressure.reduce((best, p) => (p.composite > best.value ? { value: p.composite, at: p.t } : best), { value: 0, at: 0 });
  const claimCounts: Record<Verdict, number> = { false: 0, true: 0, unverifiable: 0 };
  for (const c of s.claims) claimCounts[c.verdict]++;

  // One match row per run of consecutive scam-signal results on the same entry.
  const matches: EvidencePack["matches"] = [];
  for (const t of s.ticks) {
    const best = t.assessment.scamSignal ? t.assessment.bestScam : null;
    if (!best) continue;
    if (matches.at(-1)?.entryId === best.id) continue;
    matches.push({ at: r3(t.at), resolvedAt: r3(t.resolvedAt), family: best.family, stage: best.stage, entryId: best.id, cosine: r3(best.cosine), entryText: bundle.playbookById.get(best.id)?.text ?? "" });
  }

  const body: Omit<EvidencePack, "integrity"> = {
    schema: "kavach.evidence/v1",
    generatedAt: new Date().toISOString(),
    source: input.source,
    incident: input.incident,
    corpus: {
      version: bundle.corpus.version,
      model: bundle.manifest.model,
      playbooksIndex: bundle.manifest.indexes.playbooks.name,
      groundTruthIndex: bundle.manifest.indexes.ground_truth.name,
    },
    device: {
      userAgent: input.runtime?.userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent),
      crossOriginIsolated: input.runtime?.crossOriginIsolated ?? false,
      ortThreads: input.runtime?.ortNumThreads ?? null,
      retrievalRoundTripMs: { n: rtSummary.n, p50: rt.length ? r3(rtSummary.p50) : 0, p99: rt.length ? r3(rtSummary.p99) : 0 },
    },
    summary: {
      durationSeconds: r3(input.durationSeconds),
      warning: s.warning
        ? { at: r3(s.warning.at), family: s.warning.family, familyLabel: FAMILY_LABELS[s.warning.family], stage: s.warning.stage, entryId: s.warning.entryId, cosine: r3(s.warning.cosine) }
        : null,
      stagesReached: s.stages.map((e) => ({ stage: e.stage, label: STAGE_LABELS[e.stage], at: r3(e.at), entryId: e.entryId, cosine: r3(e.cosine) })),
      peakPressure: { value: r3(peak.value), at: r3(peak.at) },
      claimCounts,
    },
    transcript: input.segments.filter((seg) => seg.final && seg.text.trim()).map((seg) => ({ start: r3(seg.start), end: r3(seg.end), speaker: seg.speaker, text: seg.text })),
    matches,
    claims: s.claims.map((c) => {
      const gt = c.evidenceId ? bundle.groundTruthById.get(c.evidenceId) : undefined;
      return {
        at: r3(c.at),
        text: c.text,
        verdict: c.verdict,
        cosine: r3(c.cosine),
        evidence: gt && c.verdict !== "unverifiable" ? { id: gt.id, fact: gt.fact, publisher: gt.source.publisher, title: gt.source.title, url: gt.source.url } : null,
      };
    }),
    pressureCurve: s.pressure.map((p) => ({ t: r3(p.t), composite: r3(p.composite), ...Object.fromEntries(Object.entries(p.signals).map(([k, v]) => [k, r3(v)])) }) as EvidencePack["pressureCurve"][number]),
    reportingChannels: REPORTING_CHANNELS,
  };

  const digest = await sha256Hex(canonicalJson(body));
  return { ...body, integrity: { algorithm: "SHA-256", digest, covers: "canonical JSON (sorted keys) of every field except integrity" } };
}

export async function verifyEvidencePack(pack: EvidencePack): Promise<boolean> {
  const { integrity, ...body } = pack;
  return (await sha256Hex(canonicalJson(body))) === integrity.digest;
}

export function downloadFile(data: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
