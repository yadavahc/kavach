/**
 * Drives the running app in headless Chrome: smoke-tests each page end to end
 * and saves the screenshots used in the README.
 *
 *   npx tsx scripts/capture.ts --base http://localhost:3100
 *   npx tsx scripts/capture.ts --only live --headed
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import puppeteer, { type Page } from "puppeteer-core";
import { findBrowser } from "./lib/browser-session";
import { c, ROOT, section } from "./lib/cli";

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: "http://localhost:3100" },
    out: { type: "string", default: "docs/screenshots" },
    only: { type: "string", default: "landing,live,bench" },
    fixture: { type: "string", default: "fx.01.digital_arrest_parcel" },
    browser: { type: "string" },
    headed: { type: "boolean", default: false },
    /** GPU compositing in headless Chrome, so page rendering does not compete with the embedding threads for CPU. */
    gpu: { type: "boolean", default: false },
    /** Query string appended to /live, e.g. "?threads=1". */
    "live-query": { type: "string", default: "" },
  },
});

const outDir = join(ROOT, args.out);
mkdirSync(outDir, { recursive: true });
const only = new Set(args.only.split(","));
const executablePath = findBrowser(args.browser);
if (!executablePath) throw new Error("No Chrome/Edge found. Pass --browser <path>.");

const browser = await puppeteer.launch({
  executablePath,
  headless: !args.headed,
  userDataDir: join(ROOT, ".moss-cache", "capture-profile"),
  protocolTimeout: 900_000,
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1.5 },
  args: [
    "--no-first-run",
    "--no-default-browser-check",
    "--use-fake-ui-for-media-stream",
    ...(args.gpu ? ["--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", ...(process.platform === "win32" ? ["--use-angle=d3d11"] : [])] : []),
  ],
});

const problems: string[] = [];
const report: Record<string, unknown> = { base: args.base, capturedAt: new Date().toISOString() };

async function open(path: string): Promise<Page> {
  const page = await browser.newPage();
  page.on("pageerror", (err) => problems.push(`[${path}] page error: ${err instanceof Error ? err.message : String(err)}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`[${path}] console: ${msg.text()}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400 && !res.url().endsWith("favicon.ico")) problems.push(`[${path}] HTTP ${res.status()} ${res.url()}`);
  });
  await page.goto(`${args.base}${path}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  return page;
}

const clickButton = (page: Page, label: string) =>
  page.evaluate((text) => {
    const b = [...document.querySelectorAll("button")].find((el) => el.textContent?.includes(text));
    if (!b) throw new Error(`button "${text}" not found`);
    (b as HTMLButtonElement).click();
  }, label);

// innerText reflects CSS text-transform, so match case-insensitively.
const waitForText = (page: Page, text: string, timeout: number) =>
  page.waitForFunction((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()), { timeout, polling: 250 }, text);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  if (only.has("landing")) {
    section("Landing");
    const page = await open("/");
    await sleep(4000);
    await page.screenshot({ path: join(outDir, "landing.png") });
    await page.evaluate(() => document.getElementById("architecture")?.scrollIntoView());
    await sleep(1500);
    await page.screenshot({ path: join(outDir, "architecture.png") });
    console.log(c.green("  ✓ landing.png, architecture.png"));
    await page.close();
  }

  if (only.has("live")) {
    section(`Live (${args.fixture})`);
    const page = await open(`/live${args["live-query"]}`);
    const t0 = Date.now();
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent?.includes("Play fixture call")), { timeout: 300_000, polling: 500 });
    console.log(`  retrieval ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await page.select("select", args.fixture);
    await clickButton(page, "Play fixture call");
    const t1 = Date.now();
    const liveState = () =>
      page.evaluate(() => {
        const live = (window as unknown as { __kavachLive?: { snapshot: null | { ticks: { at: number; window: string; assessment: { scamSignal: boolean; margin: number; bestScam: null | { id: string; family: string; cosine: number } } }[]; warning: unknown } } }).__kavachLive;
        const ticks = live?.snapshot?.ticks ?? [];
        const ranked = [...ticks].sort((a, b) => (b.assessment.bestScam?.cosine ?? 0) - (a.assessment.bestScam?.cosine ?? 0));
        return {
          ticks: ticks.length,
          signals: ticks.filter((t) => t.assessment.scamSignal).length,
          warned: Boolean(live?.snapshot?.warning),
          top: ranked.slice(0, 5).map((t) => ({ at: t.at, id: t.assessment.bestScam?.id ?? null, family: t.assessment.bestScam?.family ?? null, cosine: t.assessment.bestScam?.cosine ?? 0, margin: t.assessment.margin, window: t.window })),
        };
      });

    const poll = setInterval(() => {
      void liveState()
        .then((s) => console.log(c.dim(`  t+${((Date.now() - t1) / 1000).toFixed(0)}s ticks=${s.ticks} signals=${s.signals} bestCosine=${(s.top[0]?.cosine ?? 0).toFixed(3)} (${s.top[0]?.id ?? "–"})`)))
        .catch(() => undefined);
    }, 5000);
    try {
      await waitForText(page, "Say this", 120_000);
    } catch (err) {
      const s = await liveState();
      console.log(c.yellow(`\n--- detection state at timeout: ${s.ticks} results, ${s.signals} scam signals ---`));
      for (const t of s.top) {
        console.log(c.yellow(`  ${t.at.toFixed(1)}s  ${t.id ?? "no scam entry"} ${t.family ?? ""} cos=${t.cosine.toFixed(3)} margin=${t.margin.toFixed(3)}`));
        console.log(c.dim(`      "${t.window}"`));
      }
      throw err;
    } finally {
      clearInterval(poll);
    }
    const warned = await page.evaluate(() => document.body.innerText.match(/warned at (\d+:\d{2})/)?.[1] ?? null);
    console.log(`  warning rendered (call time ${warned}) after ${((Date.now() - t1) / 1000).toFixed(1)} s wall`);
    await sleep(22_000);
    await page.screenshot({ path: join(outDir, "live.png"), fullPage: true });
    const header = await page.evaluate(() => document.querySelector("header")?.innerText.replace(/\s+/g, " ") ?? "");
    report.live = { fixture: args.fixture, warnedAtCallTime: warned, header };
    console.log(c.dim(`  header: ${header}`));
    console.log(c.green("  ✓ live.png"));
    await page.close();
  }

  if (only.has("bench")) {
    section("Bench");
    const page = await open("/bench");
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent?.includes("Run eval bench") && !(b as HTMLButtonElement).disabled), { timeout: 300_000, polling: 500 });
    await clickButton(page, "Run eval bench");
    const benchStart = Date.now();
    const benchPoll = setInterval(() => {
      void page
        .evaluate(() => document.body.innerText.match(/Running (\d+\/\d+:[^\n]*)/i)?.[1] ?? "")
        .then((s) => s && console.log(c.dim(`  t+${((Date.now() - benchStart) / 1000).toFixed(0)}s ${s}`)))
        .catch(() => undefined);
    }, 10_000);
    try {
      await waitForText(page, "Precision", 1_800_000);
      await page.waitForFunction(() => !/\brunning\b/i.test(document.body.innerText), { timeout: 1_800_000, polling: 500 });
    } finally {
      clearInterval(benchPoll);
    }
    await page.screenshot({ path: join(outDir, "bench.png"), fullPage: true });
    await clickButton(page, "Run A/B");
    await page.waitForFunction(() => /time to first warning/i.test(document.body.innerText) && !/\brunning\b/i.test(document.body.innerText), { timeout: 1_800_000, polling: 500 });
    await sleep(1500);
    const ab = await page.$("#ab");
    await (ab ?? page).screenshot({ path: join(outDir, "latency-ab.png") });
    report.bench = await page.evaluate(() => (window as unknown as { __kavachBench?: unknown }).__kavachBench ?? null);
    console.log(c.green("  ✓ bench.png, latency-ab.png"));
    await page.close();
  }
} catch (err) {
  problems.push(`capture failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await browser.close();
}

report.problems = problems;
writeFileSync(join(outDir, "capture-report.json"), JSON.stringify(report, null, 2) + "\n");
if (problems.length) {
  console.log(c.red(`\n✗ ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`));
  process.exitCode = 1;
} else {
  console.log(c.green("\n✓ no page errors"));
}
