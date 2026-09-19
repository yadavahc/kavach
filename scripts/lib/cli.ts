import { existsSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dirname, "..", "..");
export const DIST_DIR = join(ROOT, "corpus", "dist");

export function loadEnv(): void {
  for (const file of [".env.local", ".env"]) {
    const path = join(ROOT, file);
    if (existsSync(path)) process.loadEnvFile(path);
  }
}

export function mossCredentials(): { projectId: string; projectKey: string } {
  const projectId = process.env.MOSS_PROJECT_ID?.trim();
  const projectKey = process.env.MOSS_PROJECT_KEY?.trim();
  if (!projectId || !projectKey) {
    console.error(c.red("MOSS_PROJECT_ID and MOSS_PROJECT_KEY must be set (copy .env.example to .env.local)."));
    process.exit(2);
  }
  return { projectId, projectKey };
}

export const MODELS = ["moss-minilm", "moss-mediumlm"] as const;
export type Model = (typeof MODELS)[number];

export function resolveModel(flag: string | undefined): Model {
  const m = flag ?? process.env.MOSS_MODEL ?? "moss-minilm";
  if (!(MODELS as readonly string[]).includes(m)) {
    console.error(c.red(`Unknown model "${m}". Use one of: ${MODELS.join(", ")}`));
    process.exit(2);
  }
  return m as Model;
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: number) => (s: string | number) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = { red: wrap(31), green: wrap(32), yellow: wrap(33), cyan: wrap(36), dim: wrap(2), bold: wrap(1) };

// eslint-disable-next-line no-control-regex
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

/** Fixed-width table; numeric-looking cells are right-aligned. */
export function table(header: string[], rows: (string | number)[][]): string {
  const cells = [header, ...rows.map((r) => r.map(String))];
  const widths = header.map((_, i) => Math.max(...cells.map((r) => visible(r[i] ?? ""))));
  const line = (r: string[]) =>
    r
      .map((cell, i) => {
        const pad = " ".repeat(widths[i]! - visible(cell));
        return /^[\d.,%x/ -]+$/.test(cell) && cell.trim() ? pad + cell : cell + pad;
      })
      .join("  ");
  return [line(cells[0]!), widths.map((w) => "─".repeat(w)).join("  "), ...cells.slice(1).map(line)].join("\n");
}

export const fmtMs = (n: number) => (n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : n.toFixed(0));
export const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function section(title: string): void {
  console.log(`\n${c.bold(c.cyan(title))}`);
}
