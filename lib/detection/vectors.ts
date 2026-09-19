/**
 * Document embeddings for calibrated similarity.
 *
 * moss-web returns rank-derived scores (the top hit is always ~1.0), which
 * cannot be thresholded. Kavach keeps Moss as the retriever and re-scores only
 * the returned top-k with cosine similarity against document embeddings that
 * were produced by the same in-browser embedding model (scripts/embed-corpus.ts).
 */

export interface EncodedVectors {
  ids: string[];
  dim: number;
  /** Base64 of little-endian float32, ids.length × dim values. */
  data: string;
}

export interface DocEmbeddingsFile {
  model: string;
  dim: number;
  corpusVersion: string;
  generatedAt: string;
  indexes: { playbooks: EncodedVectors; ground_truth: EncodedVectors };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function encodeVectors(ids: string[], vectors: ArrayLike<number>[]): EncodedVectors {
  const dim = vectors[0]?.length ?? 0;
  const flat = new Float32Array(ids.length * dim);
  vectors.forEach((v, i) => {
    if (v.length !== dim) throw new Error(`vector ${ids[i]} has dim ${v.length}, expected ${dim}`);
    flat.set(v, i * dim);
  });
  return { ids, dim, data: bytesToBase64(new Uint8Array(flat.buffer)) };
}

export function decodeVectors(enc: EncodedVectors): Map<string, Float32Array> {
  const bytes = base64ToBytes(enc.data);
  const flat = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  if (flat.length !== enc.ids.length * enc.dim) throw new Error(`vector payload has ${flat.length} values, expected ${enc.ids.length * enc.dim}`);
  return new Map(enc.ids.map((id, i) => [id, flat.subarray(i * enc.dim, (i + 1) * enc.dim)]));
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
