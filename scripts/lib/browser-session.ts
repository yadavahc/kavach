/**
 * Headless-browser session for CLI scripts that must run the browser runtime:
 * bundles an entry module with esbuild, serves it with the runtime's binary
 * assets at the same /vendor/... URLs the app uses, and drives installed
 * Chrome/Edge through puppeteer-core.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, extname, join } from "node:path";
import { build } from "esbuild";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { c, fmtMs, ROOT } from "./cli";

export const VENDOR_URLS = {
  mossWasm: "/vendor/moss/moss_wasm_bg.wasm",
  ortDir: "/vendor/ort/",
} as const;

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findBrowser(explicit?: string): string | undefined {
  return explicit ?? BROWSER_CANDIDATES.find((p): p is string => Boolean(p && existsSync(p)));
}

export interface BrowserSessionOptions {
  /** Entry module, relative to the repo root. */
  entry: string;
  /** Serve with COOP/COEP so the page is cross-origin isolated. */
  isolated: boolean;
  browserPath?: string;
  headed?: boolean;
  verbose?: boolean;
}

export interface BrowserSession {
  page: Page;
  origin: string;
  executablePath: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".html": "text/html; charset=utf-8",
};

export async function openBrowserSession(opts: BrowserSessionOptions): Promise<BrowserSession> {
  const executablePath = findBrowser(opts.browserPath);
  if (!executablePath) throw new Error("No Chrome/Edge found. Pass --browser <path> or set CHROME_PATH.");

  const t0 = performance.now();
  const bundle = await build({
    entryPoints: [join(ROOT, opts.entry)],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    // Same ONNX Runtime build as the app bundle (scripts/bundle-runtime.ts), so
    // verification measures the code the app actually runs.
    alias: { "onnxruntime-web": "onnxruntime-web/wasm" },
    write: false,
    logLevel: "error",
  });
  const js = bundle.outputFiles[0]!.text;
  console.log(c.dim(`  bundled ${opts.entry} (${(js.length / 1024).toFixed(0)} KB) in ${fmtMs(performance.now() - t0)} ms`));

  const ortDir = join(ROOT, "node_modules", "onnxruntime-web", "dist");
  const mossWasm = join(ROOT, "node_modules", "@moss-dev", "moss-wasm", "moss_wasm_bg.wasm");
  const send = (res: ServerResponse, status: number, type: string, body: string | Buffer) => {
    res.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
      ...(opts.isolated ? { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "credentialless" } : {}),
    });
    res.end(body);
  };
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/") return send(res, 200, MIME[".html"]!, `<!doctype html><meta charset="utf-8"><title>kavach harness</title><script type="module" src="/entry.js"></script>`);
    if (path === "/favicon.ico") return send(res, 204, "image/x-icon", "");
    if (path === "/entry.js") return send(res, 200, MIME[".js"]!, js);
    if (path === VENDOR_URLS.mossWasm) return send(res, 200, MIME[".wasm"]!, readFileSync(mossWasm));
    if (path.startsWith(VENDOR_URLS.ortDir)) {
      const file = join(ortDir, basename(path));
      if (existsSync(file)) return send(res, 200, MIME[extname(file)] ?? "application/octet-stream", readFileSync(file));
    }
    send(res, 404, "text/plain", "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let browser: Browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: !opts.headed,
      userDataDir: join(ROOT, ".moss-cache", "chrome-profile"), // keeps the ONNX model in HTTP cache between runs
      protocolTimeout: 900_000,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
  } catch (err) {
    server.close();
    throw err;
  }

  const close = async () => {
    await browser.close();
    server.close();
  };

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(600_000);
    page.on("pageerror", (err) => console.error(c.red(`  [page error] ${err instanceof Error ? err.message : String(err)}`)));
    page.on("console", (msg) => {
      if (msg.type() === "error" || opts.verbose) console.log(c.dim(`  [page ${msg.type()}] ${msg.text()}`));
    });
    page.on("response", (res) => {
      if (res.status() >= 400) console.log(c.yellow(`  [http ${res.status()}] ${res.url()}`));
    });
    await page.goto(origin);
    await page.waitForFunction(() => typeof (window as unknown as { __kavach?: unknown }).__kavach !== "undefined");
    return { page, origin, executablePath, close };
  } catch (err) {
    await close();
    throw err;
  }
}
