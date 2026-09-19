/**
 * Reachability check for every ground-truth source URL.
 *   npm run corpus:sources
 *
 * Evidence shown to a user must link somewhere real. Many government and
 * regulator sites sit behind bot protection that rejects scripted clients, so
 * results are three-way and reported as-is:
 *   ok           2xx after redirects
 *   unconfirmed  401/403/429 or connection reset: the host answered but refused a script; check in a browser
 *   dead         404/410, DNS failure, or 5xx: fails the run
 */
import { CorpusError, loadCorpus } from "../corpus/load";
import { c, section, table } from "./lib/cli";

const TIMEOUT_MS = 20_000;
const HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en-US,en;q=0.9",
};

type Outcome = "ok" | "unconfirmed" | "dead";

let groundTruth;
try {
  ({ groundTruth } = loadCorpus());
} catch (err) {
  if (err instanceof CorpusError) {
    console.error(c.red(err.message));
    process.exit(1);
  }
  throw err;
}

const byUrl = new Map<string, string[]>();
for (const g of groundTruth) byUrl.set(g.source.url, [...(byUrl.get(g.source.url) ?? []), g.id]);

async function probe(url: string): Promise<{ status: string; outcome: Outcome }> {
  const init = { redirect: "follow", headers: HEADERS } as const;
  try {
    let res = await fetch(url, { ...init, method: "HEAD", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) res = await fetch(url, { ...init, method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const outcome: Outcome = res.ok ? "ok" : [401, 403, 429].includes(res.status) ? "unconfirmed" : "dead";
    return { status: String(res.status), outcome };
  } catch (err) {
    const cause = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
    const refused = /ECONNRESET|other side closed|socket hang up|timeout|aborted/i.test(cause);
    return { status: cause, outcome: refused ? "unconfirmed" : "dead" };
  }
}

section(`Checking ${byUrl.size} source URLs (${groundTruth.length} ground-truth entries)`);
const rows = await Promise.all([...byUrl].map(async ([url, ids]) => ({ url, ids, ...(await probe(url)) })));
const paint = { ok: c.green, unconfirmed: c.yellow, dead: c.red } as const;
console.log(
  table(
    ["result", "status", "url", "entries"],
    rows.map((r) => [paint[r.outcome](r.outcome), r.status, r.url, r.ids.length]),
  ),
);

const report = (outcome: Outcome) => {
  const hit = rows.filter((r) => r.outcome === outcome);
  return { urls: hit.length, ids: hit.flatMap((r) => r.ids) };
};
const unconfirmed = report("unconfirmed");
const dead = report("dead");
if (unconfirmed.urls) {
  console.log(c.yellow(`\n! ${unconfirmed.urls} URL(s) refused a scripted client; confirm in a browser: ${unconfirmed.ids.join(", ")}`));
}
if (dead.urls) {
  console.log(c.red(`\n✗ ${dead.urls} URL(s) dead, affecting ${dead.ids.length} entries: ${dead.ids.join(", ")}`));
  process.exitCode = 1;
} else {
  console.log(c.green(`\n✓ no dead sources (${rows.length - unconfirmed.urls}/${rows.length} confirmed reachable)`));
}
