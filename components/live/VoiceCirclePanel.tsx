"use client";

import { useEffect, useState } from "react";
import { FAMILY_LABELS, type Family } from "@/corpus/taxonomy";
import { checkPassphrase, loadVoiceCircle, newContactId, saveVoiceCircle, withPassphrase, type Contact, type VoiceCircle } from "@/lib/voice-circle/store";
import { captureVoiceprint, voiceprintSimilarity } from "@/lib/voice-circle/voiceprint";
import { Chip, Meter } from "../ui";

const input = "w-full rounded-md border border-line bg-ink px-2.5 py-1.5 text-[13px] text-fg placeholder:text-faint focus:border-accent focus:outline-none";
const button = "rounded-md border border-line bg-panel-2 px-3 py-1.5 text-[12px] text-fg hover:border-accent disabled:opacity-50";

export function VoiceCirclePanel({ alert }: { alert: { at: number; entryId: string; family: Family } | null }) {
  const [circle, setCircle] = useState<VoiceCircle>({ contacts: [], passphrase: null });
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState("");
  const [attemptResult, setAttemptResult] = useState<boolean | null>(null);
  const [compare, setCompare] = useState<{ name: string; similarity: number }[] | null>(null);
  const [draft, setDraft] = useState({ name: "", relation: "", callback: "" });
  const [phrase, setPhrase] = useState({ value: "", hint: "" });

  useEffect(() => setCircle(loadVoiceCircle()), []);

  const update = (next: VoiceCircle) => {
    setCircle(next);
    saveVoiceCircle(next);
  };

  const capture = async (label: string) => {
    setBusy(label);
    setMessage("Speak naturally for 6 seconds…");
    try {
      return await captureVoiceprint(6, setLevel);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Microphone unavailable.");
      return null;
    } finally {
      setBusy(null);
      setLevel(0);
    }
  };

  const enrol = async (contact: Contact) => {
    const vp = await capture(contact.id);
    if (!vp) return;
    update({ ...circle, contacts: circle.contacts.map((c) => (c.id === contact.id ? { ...c, voiceprint: vp, enrolledAt: new Date().toISOString() } : c)) });
    setMessage(`Voice signature saved for ${contact.name}.`);
  };

  const compareVoice = async () => {
    const vp = await capture("compare");
    if (!vp) return;
    setCompare(circle.contacts.filter((c) => c.voiceprint).map((c) => ({ name: c.name, similarity: voiceprintSimilarity(vp, c.voiceprint!) })).sort((a, b) => b.similarity - a.similarity));
    setMessage(null);
  };

  return (
    <div className="flex flex-col gap-3">
      {alert ? (
        <div className="rounded-lg border border-warn/50 bg-warn/10 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-warn">Verify who this is · {FAMILY_LABELS[alert.family]}</div>
          <p className="mt-1 text-[13px] leading-snug text-fg">
            This call follows a script that impersonates someone you know. A familiar voice proves nothing: three seconds of audio is enough to clone it.
          </p>
          <ol className="mt-2 flex list-decimal flex-col gap-2 pl-5 text-[13px] text-fg/90">
            <li>
              Ask for the household passphrase{circle.passphrase?.hint ? ` (hint: ${circle.passphrase.hint})` : ""}.
              {circle.passphrase ? (
                <div className="mt-1.5 flex gap-2">
                  <input className={input} value={attempt} onChange={(e) => { setAttempt(e.target.value); setAttemptResult(null); }} placeholder="Type what the caller says" />
                  <button className={button} type="button" onClick={async () => setAttemptResult(await checkPassphrase(circle, attempt))}>
                    Check
                  </button>
                </div>
              ) : (
                <span className="text-muted"> No passphrase set yet; add one below.</span>
              )}
              {attemptResult !== null && <div className="mt-1">{attemptResult ? <Chip tone="ok">Passphrase matches</Chip> : <Chip tone="danger">Passphrase does not match</Chip>}</div>}
            </li>
            <li>
              Hang up and call back on a number you already have:
              <ul className="mt-1 flex flex-col gap-0.5 text-muted">
                {circle.contacts.length ? circle.contacts.map((c) => <li key={c.id}>{c.name} ({c.relation}): {c.callback || "saved contact"}</li>) : <li>No trusted contacts saved yet.</li>}
              </ul>
            </li>
            <li>
              Optional hint only:{" "}
              <button className={button} type="button" disabled={Boolean(busy) || !circle.contacts.some((c) => c.voiceprint)} onClick={compareVoice}>
                {busy === "compare" ? "Listening…" : "Compare voice (6 s)"}
              </button>
              {compare && (
                <ul className="mt-1.5 flex flex-col gap-1">
                  {compare.map((r) => (
                    <li key={r.name} className="text-[12px] text-muted">
                      {r.name}: spectral similarity {r.similarity.toFixed(2)}. A match does not mean it is them.
                    </li>
                  ))}
                </ul>
              )}
            </li>
          </ol>
        </div>
      ) : (
        <p className="text-[13px] text-muted">
          If a call matches a script that impersonates a family member or your boss, this panel walks you through verifying them outside the call.
        </p>
      )}

      {busy && <Meter value={Math.min(1, level * 8)} tone="accent" />}
      {message && <p className="text-[12px] text-muted">{message}</p>}

      <details className="rounded-lg border border-line/70 p-3">
        <summary className="cursor-pointer text-[12px] font-medium text-fg">
          Manage Voice Circle · {circle.contacts.length} contact{circle.contacts.length === 1 ? "" : "s"}, passphrase {circle.passphrase ? "set" : "not set"}
        </summary>
        <p className="mt-2 text-[11.5px] text-faint">Stored only in this browser. The passphrase is kept as a salted SHA-256 hash.</p>

        <ul className="mt-2 flex flex-col gap-1.5">
          {circle.contacts.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 text-[12.5px]">
              <span className="text-fg">{c.name}</span>
              <span className="text-muted">{c.relation}</span>
              {c.voiceprint ? <Chip tone="ok">voice saved</Chip> : <Chip>no voice</Chip>}
              <button className={`${button} ml-auto`} type="button" disabled={Boolean(busy)} onClick={() => enrol(c)}>
                {busy === c.id ? "Listening…" : c.voiceprint ? "Re-record" : "Record voice"}
              </button>
              <button className={button} type="button" onClick={() => update({ ...circle, contacts: circle.contacts.filter((x) => x.id !== c.id) })}>
                Remove
              </button>
            </li>
          ))}
        </ul>

        <form
          className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.name.trim()) return;
            update({ ...circle, contacts: [...circle.contacts, { id: newContactId(), name: draft.name.trim(), relation: draft.relation.trim(), callback: draft.callback.trim(), voiceprint: null, enrolledAt: new Date().toISOString() }] });
            setDraft({ name: "", relation: "", callback: "" });
          }}
        >
          <input className={input} placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className={input} placeholder="Relation (e.g. son, manager)" value={draft.relation} onChange={(e) => setDraft({ ...draft, relation: e.target.value })} />
          <input className={input} placeholder="Call back via (e.g. saved contact)" value={draft.callback} onChange={(e) => setDraft({ ...draft, callback: e.target.value })} />
          <button className={`${button} sm:col-span-3`} type="submit">
            Add trusted contact
          </button>
        </form>

        <form
          className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (phrase.value.trim().length < 4) return setMessage("Use a passphrase of at least 4 characters.");
            update(await withPassphrase(circle, phrase.value, phrase.hint));
            setPhrase({ value: "", hint: "" });
            setMessage("Household passphrase saved.");
          }}
        >
          <input className={input} type="password" placeholder="Household passphrase" value={phrase.value} onChange={(e) => setPhrase({ ...phrase, value: e.target.value })} />
          <input className={input} placeholder="Hint (optional)" value={phrase.hint} onChange={(e) => setPhrase({ ...phrase, hint: e.target.value })} />
          <button className={button} type="submit">
            {circle.passphrase ? "Replace passphrase" : "Set passphrase"}
          </button>
        </form>
      </details>
    </div>
  );
}
