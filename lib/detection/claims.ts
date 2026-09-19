/**
 * Atomic assertion extraction. A finished utterance is split into clauses and
 * a clause is checked only if it is declarative, of checkable length, and
 * contains a claim cue (a state, obligation, institution or credential).
 */

const CUE =
  /\b(is|are|was|were|has|have|had|will|must|cannot|can't|won't|never|already|needs? to|has to|have to|required|mandatory|registered|linked|blocked|suspended|arrest(?:ed)?|seized|frozen|expired|warrant|court|judge|police|customs|bank|account|otp|pin|code|password|refund|transfer|payment|fee|bail|virus|hackers?|number|gag order|officer)\b/i;

const CONNECTIVE = /^(?:and|but|so|because|otherwise|or|then)\s+/i;
const FILLER = /^(?:okay|ok|yes|no|sir|madam|ma'am|please|listen|look|well|hello|hi|good|right|sure)[,!.\s]+/i;

export const ASSERTION_WORDS = { min: 5, max: 40 } as const;

export function extractAssertions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const clauses = text
    .split(/(?<=[.!?])\s+/)
    .flatMap((s) => s.split(/;\s+|,\s+(?=(?:and|but|so|because|otherwise|or)\s)/i));
  for (const raw of clauses) {
    let s = raw.trim();
    for (let i = 0; i < 3 && (FILLER.test(s) || CONNECTIVE.test(s)); i++) s = s.replace(FILLER, "").replace(CONNECTIVE, "").trim();
    const n = s.split(/\s+/).filter(Boolean).length;
    if (n < ASSERTION_WORDS.min || n > ASSERTION_WORDS.max || s.endsWith("?") || !CUE.test(s)) continue;
    const key = s.toLowerCase().replace(/[^a-z0-9 ]/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.replace(/[.!]+$/, ""));
  }
  return out;
}

/** Word-overlap similarity used to align extracted assertions with annotated claim spans. */
export function overlap(a: string, b: string): number {
  const tok = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean));
  const A = tok(a);
  const B = tok(b);
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return A.size + B.size ? inter / Math.min(A.size, B.size) : 0;
}
