import type { CorpusBundle } from "@/lib/corpus/client-data";
import type { ClaimRecord } from "@/lib/detection/engine";
import { clock } from "@/lib/evidence/pack";
import { Chip, Empty } from "../ui";

const VERDICT = {
  false: { tone: "danger", label: "Contradicted" },
  true: { tone: "ok", label: "Consistent" },
  unverifiable: { tone: "neutral", label: "Unverifiable" },
} as const;

export function ClaimList({ claims, bundle }: { claims: ClaimRecord[]; bundle: CorpusBundle }) {
  if (!claims.length) return <Empty>Caller assertions are checked when an utterance ends.</Empty>;
  return (
    <ul className="flex flex-col gap-2.5">
      {[...claims].reverse().map((c) => {
        const gt = c.evidenceId ? bundle.groundTruthById.get(c.evidenceId) : undefined;
        const v = VERDICT[c.verdict];
        return (
          <li key={c.id} className="rounded-lg border border-line/70 p-2.5">
            <div className="mb-1 flex items-center gap-2">
              <Chip tone={v.tone}>{v.label}</Chip>
              <span className="tabular font-mono text-[11px] text-faint">{clock(c.at)}</span>
              <span className="ml-auto tabular font-mono text-[11px] text-muted" title="Cosine similarity to the closest ground-truth claim">
                {c.cosine.toFixed(3)}
              </span>
            </div>
            <p className="text-[13px] leading-snug text-fg">“{c.text}”</p>
            {gt && c.verdict !== "unverifiable" && (
              <div className="mt-1.5 border-l-2 border-line pl-2.5">
                <p className="text-[12.5px] leading-snug text-muted">{gt.fact}</p>
                <a href={gt.source.url} target="_blank" rel="noreferrer" className="mt-0.5 inline-block text-[11px] text-accent hover:underline">
                  {gt.source.publisher} · {gt.source.title}
                </a>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
