/**
 * Coarse voice signature: mean and spread of log-spaced spectral band energy
 * over a few seconds of speech, loudness-normalised.
 *
 * This is deliberately NOT an authenticator. A cloned voice is built to match
 * exactly this kind of signal, which is the premise of Kavach. It is only a
 * hint for the out-of-band verification prompt; the passphrase and a call-back
 * on a known number are the actual checks.
 */
import { cosine } from "../detection/vectors";

const BANDS = 32;
const MIN_HZ = 80;
const MAX_HZ = 7600;
const SILENCE_RMS = 0.01;

export async function captureVoiceprint(seconds = 6, onLevel?: (rms: number) => void): Promise<number[]> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext();
  try {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    ctx.createMediaStreamSource(stream).connect(analyser);

    const freq = new Float32Array(analyser.frequencyBinCount);
    const time = new Float32Array(analyser.fftSize);
    const hzPerBin = ctx.sampleRate / analyser.fftSize;
    const edges = Array.from({ length: BANDS + 1 }, (_, i) => Math.round((MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, i / BANDS)) / hzPerBin));
    const sum = new Float64Array(BANDS);
    const sumSq = new Float64Array(BANDS);
    let frames = 0;

    const end = performance.now() + seconds * 1000;
    while (performance.now() < end) {
      await new Promise((r) => setTimeout(r, 20));
      analyser.getFloatTimeDomainData(time);
      const rms = Math.sqrt(time.reduce((s, x) => s + x * x, 0) / time.length);
      onLevel?.(rms);
      if (rms < SILENCE_RMS) continue;
      analyser.getFloatFrequencyData(freq);
      for (let b = 0; b < BANDS; b++) {
        const lo = edges[b]!;
        const hi = Math.max(lo + 1, edges[b + 1]!);
        let acc = 0;
        for (let k = lo; k < hi; k++) acc += freq[k]!;
        const v = acc / (hi - lo);
        sum[b]! += v;
        sumSq[b]! += v * v;
      }
      frames++;
    }
    if (frames < 25) throw new Error("Not enough speech captured. Speak continuously and try again.");

    const mean = Array.from(sum, (s) => s / frames);
    const std = mean.map((m, b) => Math.sqrt(Math.max(0, sumSq[b]! / frames - m * m)));
    const level = mean.reduce((a, b) => a + b, 0) / BANDS;
    return [...mean.map((m) => m - level), ...std];
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
  }
}

export function voiceprintSimilarity(a: number[], b: number[]): number {
  return a.length === b.length ? cosine(a, b) : 0;
}
