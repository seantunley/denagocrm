import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { winAnsi } from "./dealFileZipRules";

export type CoverSheetInput = {
  brand: string;
  /** "Q-1029 · Anna Smith" */
  title: string;
  generatedAt: string;
  generatedBy: string;
  quotes: { label: string; status: string; total: string; created: string }[];
  checklist: { label: string; done: boolean; detail: string }[];
  suppliers: string[];
  /** Every file in the ZIP besides this sheet, in ZIP order. */
  files: { path: string; type: string; detail: string }[];
  /** Anything left out or not made, said plainly. */
  notes: string[];
};

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 48;
const GREY = rgb(0.4, 0.4, 0.4);
const GREEN = rgb(0.1, 0.5, 0.25);
const AMBER = rgb(0.72, 0.42, 0.02);

/**
 * The first page of the deal-file ZIP: what the deal is, the checklist as it stood when downloaded, and an index of
 * every file — so the pack stands on its own as an audit record. Plain built-in fonts; no client data beyond what is
 * already in the pack.
 */
export async function coverSheetPdf(input: CoverSheetInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(winAnsi(`Deal file ${input.title}`));
  pdf.setProducer(winAnsi(input.brand));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - MARGIN;
  const width = A4[0] - MARGIN * 2;

  const newPageIfNeeded = (height: number) => {
    if (y - height >= MARGIN) return;
    page = pdf.addPage(A4);
    y = A4[1] - MARGIN;
  };
  const wrap = (text: string, f: PDFFont, size: number, max: number): string[] => {
    const lines: string[] = [];
    let line = "";
    for (const word of winAnsi(text).split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(next, size) <= max || !line) line = next;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    return lines;
  };
  const write = (text: string, opts: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb>; indent?: number; gap?: number } = {}) => {
    const size = opts.size ?? 9.5;
    const f = opts.f ?? font;
    const indent = opts.indent ?? 0;
    for (const line of wrap(text, f, size, width - indent)) {
      newPageIfNeeded(size + 3);
      page.drawText(line, { x: MARGIN + indent, y: y - size, size, font: f, color: opts.color ?? rgb(0.1, 0.1, 0.1) });
      y -= size + 3;
    }
    y -= opts.gap ?? 0;
  };
  const heading = (text: string) => {
    y -= 8;
    newPageIfNeeded(30);
    write(text, { size: 12, f: bold, gap: 4 });
  };

  write(input.brand, { size: 10, color: GREY });
  write(`Deal file ${input.title}`, { size: 18, f: bold, gap: 4 });
  write(`Downloaded ${input.generatedAt} by ${input.generatedBy}. Checklist and contents as they stood at that moment.`, { color: GREY, gap: 6 });

  const done = input.checklist.filter((item) => item.done).length;
  heading(`Checklist — ${done} of ${input.checklist.length} on file`);
  for (const item of input.checklist) {
    write(`${item.done ? "[DONE]" : "[MISSING]"}  ${item.label}`, { f: bold, color: item.done ? GREEN : AMBER });
    if (item.detail) write(item.detail, { indent: 14, color: GREY, size: 8.5 });
  }

  heading("Quotes on this deal");
  for (const quote of input.quotes) write(`${quote.label} · ${quote.status} · ${quote.total} · created ${quote.created}`);

  if (input.suppliers.length) {
    heading("Suppliers on this deal");
    write(input.suppliers.join(", "));
  }

  heading(`Contents — ${input.files.length} file${input.files.length === 1 ? "" : "s"}`);
  input.files.forEach((file, index) => {
    write(`${index + 1}. ${file.path}`, { f: bold, size: 9 });
    write(`${file.type}${file.detail ? ` · ${file.detail}` : ""}`, { indent: 14, color: GREY, size: 8.5 });
  });

  if (input.notes.length) {
    heading("Notes");
    for (const note of input.notes) write(`• ${note}`);
  }
  heading("About this file");
  write("This ZIP is encrypted with AES-256. Open it with 7-Zip or WinRAR (Windows), or The Unarchiver or Keka (Mac): Windows' built-in \"Extract all\" cannot open it. The password was chosen when it was downloaded and is not stored by the CRM.", { color: GREY });

  return pdf.save();
}
