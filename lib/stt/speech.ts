/**
 * Streaming speech-to-text through the Web Speech API.
 *
 * Chrome can run recognition on-device (processLocally), which keeps call
 * audio on the device. Where that is not available the browser's own speech
 * service is used and the UI says so; if speech recognition is unavailable
 * entirely the app runs from fixture transcripts instead.
 */

export type SttMode = "on-device" | "browser-service" | "unavailable";

export interface SttCapability {
  mode: SttMode;
  /** The on-device model exists but must be downloaded first. */
  installable: boolean;
  detail: string;
}

interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: RecognitionAlternative;
}
interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: RecognitionResult };
}
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  processLocally?: boolean;
  onresult: ((ev: RecognitionEvent) => void) | null;
  onerror: ((ev: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type AvailabilityOptions = { langs: string[]; processLocally: boolean };
interface RecognitionCtor {
  new (): Recognition;
  available?: (opts: AvailabilityOptions) => Promise<string>;
  install?: (opts: AvailabilityOptions) => Promise<boolean>;
}

function recognitionCtor(): RecognitionCtor | undefined {
  const w = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export async function detectStt(lang = "en-US"): Promise<SttCapability> {
  const Ctor = recognitionCtor();
  if (!Ctor) return { mode: "unavailable", installable: false, detail: "This browser has no Web Speech API. Use a fixture call." };
  if (typeof Ctor.available === "function") {
    try {
      const status = await Ctor.available({ langs: [lang], processLocally: true });
      if (status === "available") return { mode: "on-device", installable: false, detail: "On-device recognition: audio stays on this device." };
      if (status === "downloadable" || status === "downloading") {
        return { mode: "browser-service", installable: true, detail: `On-device model ${status}. Until installed, the browser's speech service processes audio.` };
      }
    } catch {
      // fall through to the browser service
    }
  }
  return { mode: "browser-service", installable: false, detail: "The browser's speech service processes audio. On-device recognition is not available here." };
}

export async function installOnDeviceStt(lang = "en-US"): Promise<boolean> {
  const Ctor = recognitionCtor();
  if (!Ctor?.install) return false;
  try {
    return await Ctor.install({ langs: [lang], processLocally: true });
  } catch {
    return false;
  }
}

export interface SttUpdate {
  /** Stable key for a recognition result across interim revisions. */
  key: string;
  text: string;
  final: boolean;
}

export interface SttHandle {
  stop(): void;
}

export function startStt(opts: { lang?: string; onDevice: boolean; onUpdate(u: SttUpdate): void; onError(message: string): void }): SttHandle {
  const Ctor = recognitionCtor();
  if (!Ctor) throw new Error("Web Speech API unavailable");
  let stopped = false;
  let session = 0;
  let rec: Recognition;

  const begin = () => {
    rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = opts.lang ?? "en-US";
    if (opts.onDevice) rec.processLocally = true;
    const id = ++session;
    rec.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i]!;
        const text = r[0]?.transcript.trim() ?? "";
        if (text) opts.onUpdate({ key: `${id}:${i}`, text, final: r.isFinal });
      }
    };
    rec.onerror = (ev) => {
      if (ev.error !== "no-speech" && ev.error !== "aborted") opts.onError(ev.message || ev.error);
    };
    // Continuous recognition still ends on long silences; restart until stopped.
    rec.onend = () => {
      if (!stopped) begin();
    };
    rec.start();
  };

  begin();
  return {
    stop() {
      stopped = true;
      rec.stop();
    },
  };
}
