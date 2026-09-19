/**
 * Copies the browser runtime's binary assets and the built corpus artifacts
 * into public/ so Next.js serves them same-origin (required under
 * cross-origin isolation). Runs automatically before `dev` and `build`.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const ASSETS: [from: string, to: string][] = [
  ["node_modules/@moss-dev/moss-wasm/moss_wasm_bg.wasm", "public/vendor/moss/moss_wasm_bg.wasm"],
  ["node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", "public/vendor/ort/ort-wasm-simd-threaded.wasm"],
  ["node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs", "public/vendor/ort/ort-wasm-simd-threaded.mjs"],
  ["corpus/dist/manifest.json", "public/data/manifest.json"],
  ["corpus/dist/client-corpus.json", "public/data/client-corpus.json"],
  ["corpus/dist/doc-embeddings.json", "public/data/doc-embeddings.json"],
];

for (const [from, to] of ASSETS) {
  const src = join(ROOT, from);
  if (!existsSync(src)) {
    console.error(`vendor: missing ${from} (run npm install, npm run index:build and npm run corpus:embed)`);
    process.exit(1);
  }
  const dst = join(ROOT, to);
  mkdirSync(join(dst, ".."), { recursive: true });
  copyFileSync(src, dst);
  console.log(`vendor: ${to} (${(statSync(dst).size / 1e6).toFixed(2)} MB)`);
}
