"use client";

import { useState } from "react";
import { downloadFile, type EvidenceIncident, type EvidencePack } from "@/lib/evidence/pack";

const input = "w-full rounded-md border border-line bg-ink px-2.5 py-1.5 text-[13px] text-fg placeholder:text-faint focus:border-accent focus:outline-none";
const button = "rounded-md border border-line bg-panel-2 px-3 py-1.5 text-[12px] text-fg hover:border-accent disabled:opacity-50";

export function EvidencePanel({ build, disabled }: { build: (incident: EvidenceIncident) => Promise<EvidencePack>; disabled: boolean }) {
  const [incident, setIncident] = useState<EvidenceIncident>({ reporterName: "", callerNumber: "", amountLost: "", notes: "" });
  const [busy, setBusy] = useState<"json" | "pdf" | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exportAs = async (kind: "json" | "pdf") => {
    setBusy(kind);
    setError(null);
    try {
      const pack = await build(incident);
      const stamp = pack.generatedAt.replace(/[:.]/g, "-");
      if (kind === "json") {
        downloadFile(JSON.stringify(pack, null, 2), `kavach-evidence-${stamp}.json`, "application/json");
      } else {
        const { renderEvidencePdf } = await import("@/lib/evidence/pdf");
        const bytes = await renderEvidencePdf(pack);
        downloadFile(bytes as BlobPart, `kavach-evidence-${stamp}.pdf`, "application/pdf");
      }
      setDigest(pack.integrity.digest);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  };

  const field = (key: keyof EvidenceIncident, placeholder: string) => (
    <input className={input} placeholder={placeholder} value={incident[key]} onChange={(e) => setIncident({ ...incident, [key]: e.target.value })} />
  );

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[12.5px] text-muted">Timestamped transcript, matched patterns, claim checks and the pressure curve, built on this device for a cybercrime complaint.</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {field("reporterName", "Your name")}
        {field("callerNumber", "Caller's number")}
        {field("amountLost", "Amount lost, if any")}
        {field("notes", "Notes")}
      </div>
      <div className="flex flex-wrap gap-2">
        <button className={button} type="button" disabled={disabled || Boolean(busy)} onClick={() => exportAs("pdf")}>
          {busy === "pdf" ? "Building PDF…" : "Export printable PDF"}
        </button>
        <button className={button} type="button" disabled={disabled || Boolean(busy)} onClick={() => exportAs("json")}>
          {busy === "json" ? "Building…" : "Export JSON"}
        </button>
      </div>
      {digest && (
        <p className="break-all font-mono text-[11px] text-faint">
          SHA-256 {digest}
        </p>
      )}
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </div>
  );
}
