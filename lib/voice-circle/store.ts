/**
 * Voice Circle: trusted contacts and a household passphrase, stored only on
 * this device. The passphrase is kept as a salted SHA-256 hash.
 */

export interface Contact {
  id: string;
  name: string;
  relation: string;
  /** Where to call back, e.g. "saved as Mom in contacts". Never taken from the incoming call. */
  callback: string;
  /** Coarse spectral signature from lib/voice-circle/voiceprint.ts, or null if not enrolled. */
  voiceprint: number[] | null;
  enrolledAt: string;
}

export interface VoiceCircle {
  contacts: Contact[];
  passphrase: { salt: string; hash: string; hint: string } | null;
}

const KEY = "kavach.voice-circle.v1";
const EMPTY: VoiceCircle = { contacts: [], passphrase: null };

export function loadVoiceCircle(): VoiceCircle {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<VoiceCircle>;
    return { contacts: Array.isArray(parsed.contacts) ? parsed.contacts : [], passphrase: parsed.passphrase ?? null };
  } catch {
    return EMPTY;
  }
}

export function saveVoiceCircle(vc: VoiceCircle): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(vc));
  } catch {
    // storage unavailable (private window): the circle lives for this session only
  }
}

const normalise = (phrase: string) => phrase.trim().toLowerCase().replace(/\s+/g, " ");

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function withPassphrase(vc: VoiceCircle, phrase: string, hint: string): Promise<VoiceCircle> {
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  return { ...vc, passphrase: { salt, hash: await sha256Hex(`${salt}:${normalise(phrase)}`), hint: hint.trim() } };
}

export async function checkPassphrase(vc: VoiceCircle, attempt: string): Promise<boolean> {
  if (!vc.passphrase) return false;
  return (await sha256Hex(`${vc.passphrase.salt}:${normalise(attempt)}`)) === vc.passphrase.hash;
}

export function newContactId(): string {
  return crypto.randomUUID();
}
