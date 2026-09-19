/**
 * Bundles the retrieval Web Worker (Moss WASM + ONNX embedder + cosine
 * re-scoring) into public/vendor/kavach/worker.js. Built with esbuild rather
 * than the Next.js bundler so the WASM runtimes load exactly as they do in the
 * verification harness. Runs automatically before `dev` and `build`.
 */
import { join } from "node:path";
import { build } from "esbuild";

const ROOT = join(import.meta.dirname, "..");

const result = await build({
  entryPoints: { worker: join(ROOT, "lib", "moss", "worker.ts") },
  outdir: join(ROOT, "public", "vendor", "kavach"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  // Pin ONNX Runtime to its WASM-only build: the default entry is the JSEP/WebGPU
  // build, which loads a second 28 MB runtime we neither ship nor need.
  alias: { "onnxruntime-web": "onnxruntime-web/wasm" },
  minify: true,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

for (const [file, out] of Object.entries(result.metafile.outputs)) {
  console.log(`vendor: ${file} (${(out.bytes / 1e6).toFixed(2)} MB)`);
}
