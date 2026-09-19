/**
 * Kavach corpus schema.
 *
 * Three record types feed two Moss indexes plus the eval bench:
 *   PlaybookEntry     -> index "playbooks"     (what scam scripts SOUND like, by stage)
 *   GroundTruthEntry  -> index "ground_truth"  (assertion-shaped claims + verified counter-facts)
 *   FixtureCall       -> eval bench only       (never indexed; leakage-checked against the corpus)
 *   Probe             -> verify script only    (never indexed; leakage-checked against the corpus)
 *
 * Moss metadata is Record<string, string>, so only the small set of filterable
 * fields goes into Moss. The full record (signals, notes, sources) ships with
 * the client and is joined back by doc id.
 */
import { z } from "zod";

export const SCHEMA_VERSION = 1;

// ── Taxonomy (dependency-free, shared with browser code) ───────────────────

import { FAMILIES, GT_TOPICS, IMPERSONATION, LOCALES, SCAM_FAMILIES, STAGES, VERDICTS } from "./taxonomy";

export * from "./taxonomy";

// ── Helpers ────────────────────────────────────────────────────────────────

export const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

const prose = (min: number, max: number) =>
  z
    .string()
    .trim()
    .refine((s) => wordCount(s) >= min && wordCount(s) <= max, {
      message: `must be ${min}-${max} words of prose`,
    })
    .refine((s) => /[.?!…"']$/.test(s), { message: "must be full sentences ending in punctuation" });

const intensity = z.int().min(0).max(3);

// ── Playbooks ──────────────────────────────────────────────────────────────

/**
 * One chunk of a scam (or benign contrast) script, as the CALLER would say it.
 * Length is calibrated to the ~8s rolling window (≈18-25 spoken words), so
 * entries are 15-60 words: close enough in length to the query that cosine
 * similarity is not diluted by unrelated sentences.
 */
export const PlaybookEntrySchema = z
  .object({
    id: z.string().regex(/^pb\.[a-z_]+\.[a-z_]+\.\d{2}$/, "id must be pb.<family>.<stage|context>.<nn>"),
    family: z.enum(FAMILIES),
    /** Scam stage; benign contrast entries use "none". */
    stage: z.enum([...STAGES, "none"]),
    /** 1 (mild hook) … 5 (money/credential leaving now). Benign entries are 0. */
    severity: z.int().min(0).max(5),
    impersonates: z.enum(IMPERSONATION),
    locale: z.enum(LOCALES),
    signals: z.object({
      urgency: intensity,
      isolation: intensity,
      secrecy: intensity,
      authority: intensity,
    }),
    text: prose(15, 60),
    /** Why this fragment is a tell (or, for benign, why it is NOT). Shown in the match panel. */
    tell: z.string().trim().min(10).max(240),
  })
  .superRefine((e, ctx) => {
    const isBenign = e.family === "benign";
    if (isBenign !== (e.stage === "none")) {
      ctx.addIssue({ code: "custom", path: ["stage"], message: 'stage "none" is required for, and only for, benign entries' });
    }
    if (isBenign !== (e.severity === 0)) {
      ctx.addIssue({ code: "custom", path: ["severity"], message: "severity 0 is required for, and only for, benign entries" });
    }
    const [, fam, ctxPart] = e.id.split(".");
    if (fam !== e.family) ctx.addIssue({ code: "custom", path: ["id"], message: `id family segment "${fam}" != family "${e.family}"` });
    if (!isBenign && ctxPart !== e.stage) {
      ctx.addIssue({ code: "custom", path: ["id"], message: `id stage segment "${ctxPart}" != stage "${e.stage}"` });
    }
  });
export type PlaybookEntry = z.infer<typeof PlaybookEntrySchema>;

// ── Ground truth ───────────────────────────────────────────────────────────

export const SourceSchema = z.object({
  publisher: z.string().min(2),
  title: z.string().min(4),
  /** Publisher page for the guidance. Checked for reachability by scripts/check-sources.ts. */
  url: z.url({ protocol: /^https$/ }),
});
export type Source = z.infer<typeof SourceSchema>;

/**
 * Atomic claim-check record.
 *
 * `claim` is written the way a caller ASSERTS it, because the query is always
 * a caller assertion; that is what gets embedded. `fact` is the evidence shown
 * to the user, with `source`.
 *
 *   stance "refutes"  -> a strong match means the caller's assertion is FALSE
 *   stance "supports" -> a strong match means the assertion is consistent with
 *                        legitimate procedure (keeps benign calls from being flagged)
 *   no match above threshold -> UNVERIFIABLE
 */
export const GroundTruthEntrySchema = z
  .object({
    id: z.string().regex(/^gt\.[a-z_]+\.\d{2}$/, "id must be gt.<topic>.<nn>"),
    topic: z.enum(GT_TOPICS),
    locale: z.enum(LOCALES),
    stance: z.enum(["refutes", "supports"]),
    claim: prose(10, 50),
    fact: prose(12, 70),
    families: z.array(z.enum(SCAM_FAMILIES)).min(1),
    source: SourceSchema,
  })
  .superRefine((e, ctx) => {
    const [, topic] = e.id.split(".");
    if (topic !== e.topic) ctx.addIssue({ code: "custom", path: ["id"], message: `id topic "${topic}" != topic "${e.topic}"` });
  });
export type GroundTruthEntry = z.infer<typeof GroundTruthEntrySchema>;

// ── Fixture calls (eval bench) ─────────────────────────────────────────────


export const ClaimAnnotationSchema = z.object({
  /** Verbatim span of the turn text that constitutes the atomic assertion. */
  span: z.string().min(4),
  expected: z.enum(VERDICTS),
  /** Ground-truth entry that should be retrieved; omitted when expected is "unverifiable". */
  groundTruthId: z.string().optional(),
});

export const TurnSchema = z.object({
  /** Seconds from call start. */
  start: z.number().min(0),
  end: z.number().positive(),
  speaker: z.enum(["caller", "callee"]),
  text: z.string().trim().min(1),
  /** Annotated scam stage for caller turns in scam calls. */
  stage: z.enum(STAGES).optional(),
  claims: z.array(ClaimAnnotationSchema).optional(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const FixtureCallSchema = z
  .object({
    /** fx.* = held-out evaluation fixtures, dev.* = calibration calls. */
    id: z.string().regex(/^(?:fx|dev)\.\d{2}\.[a-z0-9_]+$/),
    title: z.string().min(4),
    label: z.enum(["scam", "benign"]),
    family: z.enum(SCAM_FAMILIES).nullable(),
    /** Other families a detector may legitimately report (e.g. parcel hook escalating to digital arrest). */
    acceptableFamilies: z.array(z.enum(SCAM_FAMILIES)).default([]),
    locale: z.enum(LOCALES),
    synopsis: z.string().min(20),
    /**
     * Index of the first turn at which an informed human would say "this is a scam".
     * A warning after this turn's end is late; before this turn's start on a scam
     * call is early-but-correct. null for benign calls.
     */
    onsetTurn: z.int().min(0).nullable(),
    /** Index of the turn where the caller asks for the money/credential. Warning must precede it. */
    extractionTurn: z.int().min(0).nullable(),
    turns: z.array(TurnSchema).min(6),
  })
  .superRefine((c, ctx) => {
    const scam = c.label === "scam";
    if (scam !== (c.family !== null)) ctx.addIssue({ code: "custom", path: ["family"], message: "family required iff label is scam" });
    if (scam !== (c.onsetTurn !== null)) ctx.addIssue({ code: "custom", path: ["onsetTurn"], message: "onsetTurn required iff label is scam" });
    if (scam !== (c.extractionTurn !== null)) ctx.addIssue({ code: "custom", path: ["extractionTurn"], message: "extractionTurn required iff label is scam" });
    if (c.onsetTurn !== null && c.extractionTurn !== null && c.onsetTurn > c.extractionTurn) {
      ctx.addIssue({ code: "custom", path: ["onsetTurn"], message: "onsetTurn must not be after extractionTurn" });
    }
    for (const k of ["onsetTurn", "extractionTurn"] as const) {
      const v = c[k];
      if (v !== null && v >= c.turns.length) ctx.addIssue({ code: "custom", path: [k], message: `${k} out of range` });
    }
    c.turns.forEach((t, i) => {
      if (t.end <= t.start) ctx.addIssue({ code: "custom", path: ["turns", i, "end"], message: "end must be > start" });
      const prev = c.turns[i - 1];
      if (prev && t.start < prev.end) ctx.addIssue({ code: "custom", path: ["turns", i, "start"], message: "turns overlap or are out of order" });
      if (t.stage && (t.speaker !== "caller" || !scam)) {
        ctx.addIssue({ code: "custom", path: ["turns", i, "stage"], message: "stage only on caller turns of scam calls" });
      }
      // Speech-rate sanity: synthetic timing must be speakable (≤ 4.5 words/sec).
      const wps = wordCount(t.text) / (t.end - t.start);
      if (wps > 4.5) ctx.addIssue({ code: "custom", path: ["turns", i], message: `unrealistic speech rate ${wps.toFixed(1)} words/s` });
      for (const [j, cl] of (t.claims ?? []).entries()) {
        if (!t.text.includes(cl.span)) ctx.addIssue({ code: "custom", path: ["turns", i, "claims", j, "span"], message: "span not found verbatim in turn text" });
        if ((cl.expected === "unverifiable") === Boolean(cl.groundTruthId)) {
          ctx.addIssue({ code: "custom", path: ["turns", i, "claims", j], message: "groundTruthId required iff expected is true/false" });
        }
      }
    });
  });
export type FixtureCall = z.infer<typeof FixtureCallSchema>;

// ── Probes (query-correctness verification) ────────────────────────────────

export const PlaybookProbeSchema = z.object({
  id: z.string().regex(/^probe\.pb\.\d{2}$/),
  /** A rolling-window-sized utterance, paraphrased — never copied from the corpus. */
  text: z.string().min(10),
  expectFamily: z.enum(FAMILIES),
  expectStage: z.enum(STAGES).optional(),
});
export type PlaybookProbe = z.infer<typeof PlaybookProbeSchema>;

export const ClaimProbeSchema = z.object({
  id: z.string().regex(/^probe\.gt\.\d{2}$/),
  text: z.string().min(10),
  expectGroundTruthId: z.string().nullable(),
  expectVerdict: z.enum(VERDICTS),
});
export type ClaimProbe = z.infer<typeof ClaimProbeSchema>;

export const ProbeSetSchema = z.object({
  playbook: z.array(PlaybookProbeSchema).min(20),
  claim: z.array(ClaimProbeSchema).min(10),
});
export type ProbeSet = z.infer<typeof ProbeSetSchema>;
