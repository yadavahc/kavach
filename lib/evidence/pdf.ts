/**
 * Printable PDF of an evidence pack, rendered in the browser with pdf-lib so
 * the transcript never leaves the device.
 */
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { FAMILY_LABELS, STAGE_LABELS } from "../../corpus/taxonomy";
import { clock, type EvidencePack } from "./pack";

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 48;
const WIDTH = A4[0] - MARGIN * 2;
const INK = rgb(0.08, 0.09, 0.12);
const MUTED = rgb(0.42, 0.45, 0.52);
const RULE = rgb(0.85, 0.86, 0.9);
const DANGER = rgb(0.78, 0.12, 0.18);
const OK = rgb(0.1, 0.5, 0.3);

/** Standard PDF fonts only encode WinAnsi; map common symbols and replace the rest. */
function winAnsi(text: string): string {
  return text
    .replace(/→/g, "->")
    .replace(/≥/g, ">=")
    .replace(/≤/g, "<=")
    .replace(/[−‑]/g, "-")
    .replace(/₹/g, "Rs ")
    .replace(/[\t\r]/g, " ")
    .replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”•…€\n]/g, "?");
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of winAnsi(text).split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
      else {
        if (line) lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

class Writer {
  page!: PDFPage;
  y = 0;
  readonly pages: PDFPage[] = [];

  constructor(
    private readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.newPage();
  }

  newPage(): void {
    this.page = this.doc.addPage(A4);
    this.pages.push(this.page);
    this.y = A4[1] - MARGIN;
  }

  ensure(height: number): void {
    if (this.y - height < MARGIN + 28) this.newPage();
  }

  text(value: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number; width?: number; gap?: number } = {}): void {
    const size = opts.size ?? 9.5;
    const font = opts.bold ? this.bold : this.font;
    const indent = opts.indent ?? 0;
    for (const line of wrap(value, font, size, (opts.width ?? WIDTH) - indent)) {
      this.ensure(size + 3);
      this.page.drawText(line, { x: MARGIN + indent, y: this.y - size, size, font, color: opts.color ?? INK });
      this.y -= size + 3;
    }
    this.y -= opts.gap ?? 2;
  }

  heading(value: string): void {
    this.ensure(40);
    this.y -= 10;
    this.text(value, { size: 12.5, bold: true, gap: 4 });
    this.page.drawLine({ start: { x: MARGIN, y: this.y + 2 }, end: { x: MARGIN + WIDTH, y: this.y + 2 }, thickness: 0.6, color: RULE });
    this.y -= 6;
  }

  row(label: string, value: string, color = INK): void {
    const size = 9.5;
    const lines = wrap(value || "—", this.font, size, WIDTH - 130);
    this.ensure(lines.length * (size + 3));
    this.page.drawText(winAnsi(label), { x: MARGIN, y: this.y - size, size, font: this.bold, color: MUTED });
    for (const line of lines) {
      this.page.drawText(line, { x: MARGIN + 130, y: this.y - size, size, font: this.font, color });
      this.y -= size + 3;
    }
    this.y -= 2;
  }
}

function pressureChart(w: Writer, pack: EvidencePack): void {
  const height = 110;
  w.ensure(height + 24);
  const top = w.y - 4;
  const bottom = top - height;
  const duration = Math.max(1, pack.summary.durationSeconds);
  const page = w.page;
  page.drawRectangle({ x: MARGIN, y: bottom, width: WIDTH, height, borderColor: RULE, borderWidth: 0.6 });
  for (const v of [0.25, 0.5, 0.75]) {
    page.drawLine({ start: { x: MARGIN, y: bottom + v * height }, end: { x: MARGIN + WIDTH, y: bottom + v * height }, thickness: 0.3, color: RULE });
  }
  const pts = pack.pressureCurve.map((p) => ({ x: MARGIN + (p.t / duration) * WIDTH, y: bottom + Math.min(1, p.composite) * height }));
  for (let i = 1; i < pts.length; i++) page.drawLine({ start: pts[i - 1]!, end: pts[i]!, thickness: 1.2, color: DANGER });
  if (pack.summary.warning) {
    const x = MARGIN + (pack.summary.warning.at / duration) * WIDTH;
    page.drawLine({ start: { x, y: bottom }, end: { x, y: top }, thickness: 0.8, color: INK, dashArray: [3, 2] });
    page.drawText(`warning ${clock(pack.summary.warning.at)}`, { x: Math.min(x + 3, MARGIN + WIDTH - 70), y: top - 10, size: 7.5, font: w.font, color: INK });
  }
  page.drawText("0:00", { x: MARGIN, y: bottom - 10, size: 7.5, font: w.font, color: MUTED });
  page.drawText(clock(duration), { x: MARGIN + WIDTH - 22, y: bottom - 10, size: 7.5, font: w.font, color: MUTED });
  w.y = bottom - 18;
}

export async function renderEvidencePdf(pack: EvidencePack): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Scam call evidence summary");
  doc.setCreator("Kavach Live");
  doc.setCreationDate(new Date(pack.generatedAt));
  const w = new Writer(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));

  w.text("Scam call evidence summary", { size: 20, bold: true, gap: 4 });
  w.text("Generated on the user's device by Kavach Live for attaching to a cybercrime complaint. This is not an official police document.", { size: 9, color: MUTED, gap: 8 });

  w.heading("Incident");
  w.row("Generated", new Date(pack.generatedAt).toLocaleString());
  w.row("Reporter", pack.incident.reporterName);
  w.row("Caller number", pack.incident.callerNumber);
  w.row("Amount lost", pack.incident.amountLost);
  w.row("Notes", pack.incident.notes);
  w.row("Source", pack.source.mode === "fixture-replay" ? `Fixture replay (${pack.source.fixtureId})` : `Live microphone (${pack.source.speechRecognition})`);
  w.row("Call length", clock(pack.summary.durationSeconds));

  w.heading("Detection summary");
  const warn = pack.summary.warning;
  w.row("Warning", warn ? `${clock(warn.at)}  ${warn.familyLabel}, stage ${warn.stage === "none" ? "-" : STAGE_LABELS[warn.stage]} (matched ${warn.entryId}, similarity ${warn.cosine.toFixed(2)})` : "No scam warning fired", warn ? DANGER : OK);
  w.row("Stages reached", pack.summary.stagesReached.map((s) => `${s.label} at ${clock(s.at)}`).join("; ") || "None");
  w.row("Peak pressure", `${Math.round(pack.summary.peakPressure.value * 100)} / 100 at ${clock(pack.summary.peakPressure.at)}`);
  w.row("Claims checked", `${pack.summary.claimCounts.false} contradicted by published guidance, ${pack.summary.claimCounts.true} consistent, ${pack.summary.claimCounts.unverifiable} unverifiable`);
  w.text("Coercion pressure over the call", { size: 9, bold: true, color: MUTED, gap: 2 });
  pressureChart(w, pack);

  if (pack.claims.length) {
    w.heading("Caller claims checked against published guidance");
    for (const c of pack.claims) {
      const label = c.verdict === "false" ? "CONTRADICTED" : c.verdict === "true" ? "CONSISTENT" : "UNVERIFIABLE";
      w.text(`${clock(c.at)}  ${label}  "${c.text}"`, { bold: true, color: c.verdict === "false" ? DANGER : INK, gap: 1 });
      if (c.evidence) {
        w.text(c.evidence.fact, { indent: 14, gap: 1 });
        w.text(`Source: ${c.evidence.publisher}, "${c.evidence.title}", ${c.evidence.url}`, { indent: 14, size: 8, color: MUTED, gap: 5 });
      } else {
        w.y -= 4;
      }
    }
  }

  if (pack.matches.length) {
    w.heading("Matched scam script patterns");
    for (const m of pack.matches) {
      w.text(`${clock(m.resolvedAt)}  ${FAMILY_LABELS[m.family]} / ${m.stage === "none" ? "-" : STAGE_LABELS[m.stage]}  (${m.entryId}, similarity ${m.cosine.toFixed(2)})`, { bold: true, gap: 1 });
      w.text(`Known script: "${m.entryText}"`, { indent: 14, size: 8.5, color: MUTED, gap: 5 });
    }
  }

  w.heading("Transcript");
  for (const t of pack.transcript) w.text(`[${clock(t.start)}] ${t.speaker}: ${t.text}`, { gap: 3 });

  w.heading("Where to report");
  for (const r of pack.reportingChannels) w.row(r.region, `${r.name}: ${r.url}`);

  w.heading("Integrity");
  w.row("SHA-256", pack.integrity.digest);
  w.row("Covers", pack.integrity.covers);
  w.row("Corpus", `${pack.corpus.version} (${pack.corpus.model})`);

  w.pages.forEach((page, i) => {
    page.drawText(winAnsi(`Kavach Live evidence  ·  SHA-256 ${pack.integrity.digest.slice(0, 16)}…  ·  page ${i + 1} of ${w.pages.length}`), {
      x: MARGIN,
      y: 24,
      size: 7.5,
      font: w.font,
      color: MUTED,
    });
  });

  return doc.save();
}
