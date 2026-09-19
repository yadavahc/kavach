"use server";

/**
 * Optional LLM variants of the counter-line for a matched family and stage.
 * Not on the detection hot path: the pre-written line renders immediately and
 * these alternatives arrive later if an LLM key is configured (GEMINI_API_KEY,
 * or ANTHROPIC_API_KEY as a fallback). Only the family and stage are sent,
 * never the call transcript.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { FAMILY_LABELS, SCAM_FAMILIES, STAGE_LABELS, STAGES, type ScamFamily, type Stage } from "../../corpus/taxonomy";
import { COUNTER_LINES } from "../../lib/counter-lines/lines";

const GEMINI_MODEL = "gemini-3.6-flash";
const CLAUDE_MODEL = "claude-opus-5";

const LinesSchema = z.object({
  lines: z.array(z.string()).min(1).max(3),
});

export type CounterLineVariants =
  | { source: "llm"; provider: "gemini" | "claude"; model: string; lines: string[] }
  | { source: "unavailable"; reason: string };

const cache = new Map<string, CounterLineVariants>();

const SYSTEM = `You write lines that a person can say out loud during a phone call they suspect is a scam.
Each line is one calm, polite, firm sentence of at most 20 words.
A good line ends the call or moves verification to a channel the caller does not control (calling back on a known number, visiting in person, asking for a family passphrase).
Never accuse the caller, never include personal data, never suggest continuing to negotiate.`;

const prompt = (family: ScamFamily, stage: Stage) =>
  `Scam type: ${FAMILY_LABELS[family]}. Current stage of the script: ${STAGE_LABELS[stage]}.\n` +
  `Example of the tone wanted: "${COUNTER_LINES[family][stage].say}"\n` +
  `Write three different lines. Respond as JSON: {"lines": ["...", "...", "..."]}.`;

const unavailable = (reason: string): CounterLineVariants => ({ source: "unavailable", reason });

function clean(raw: string | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = LinesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.lines.map((l) => l.trim()).filter(Boolean) : null;
  } catch {
    return null;
  }
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
  error?: { message?: string };
}

async function viaGemini(family: ScamFamily, stage: Stage, apiKey: string): Promise<CounterLineVariants> {
  // One retry on transient overload (429/503), which the Gemini API reports under demand spikes.
  for (let attempt = 1; ; attempt++) {
    const result = await geminiOnce(family, stage, apiKey);
    if (attempt >= 2 || result.source === "llm" || !/error (429|503)/.test(result.reason)) return result;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function geminiOnce(family: ScamFamily, stage: Stage, apiKey: string): Promise<CounterLineVariants> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt(family, stage) }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: { type: "OBJECT", properties: { lines: { type: "ARRAY", items: { type: "STRING" } } }, required: ["lines"] },
        temperature: 0.8,
        maxOutputTokens: 4096,
      },
    }),
    signal: AbortSignal.timeout(25_000),
  });
  const body = (await res.json()) as GeminiResponse;
  if (!res.ok) return unavailable(`Gemini API error ${res.status}${body.error?.message ? `: ${body.error.message.slice(0, 160)}` : ""}`);
  if (body.promptFeedback?.blockReason) return unavailable("the model declined this request");
  const lines = clean(body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join(""));
  if (!lines?.length) return unavailable("the model returned an unexpected format");
  return { source: "llm", provider: "gemini", model: body.modelVersion ?? GEMINI_MODEL, lines };
}

async function viaClaude(family: ScamFamily, stage: Stage): Promise<CounterLineVariants> {
  try {
    const client = new Anthropic();
    const response = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: zodOutputFormat(LinesSchema) },
      system: SYSTEM,
      messages: [{ role: "user", content: prompt(family, stage) }],
    });
    if (response.stop_reason === "refusal") return unavailable("the model declined this request");
    const text = response.content.find((b) => b.type === "text");
    const lines = clean(text && text.type === "text" ? text.text : undefined);
    if (!lines?.length) return unavailable("the model returned an unexpected format");
    return { source: "llm", provider: "claude", model: response.model, lines };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return unavailable("the Anthropic API key was rejected");
    if (err instanceof Anthropic.RateLimitError) return unavailable("rate limited, try again shortly");
    if (err instanceof Anthropic.APIError) return unavailable(`Anthropic API error ${err.status ?? ""}`.trim());
    throw err;
  }
}

export async function generateCounterLines(family: ScamFamily, stage: Stage): Promise<CounterLineVariants> {
  if (!SCAM_FAMILIES.includes(family) || !STAGES.includes(stage)) return unavailable("unknown family or stage");
  const gemini = process.env.GEMINI_API_KEY?.trim();
  const claude = process.env.ANTHROPIC_API_KEY?.trim();
  if (!gemini && !claude) return unavailable("no LLM key is configured (GEMINI_API_KEY or ANTHROPIC_API_KEY)");

  const key = `${gemini ? "gemini" : "claude"}:${family}:${stage}`;
  const hit = cache.get(key);
  if (hit) return hit;

  try {
    const result = gemini ? await viaGemini(family, stage, gemini) : await viaClaude(family, stage);
    if (result.source === "llm") cache.set(key, result);
    return result;
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : "request failed");
  }
}
