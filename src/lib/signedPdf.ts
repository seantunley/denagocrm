import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { formatZAR, formatDate } from "./format";

const ORANGE = rgb(0.917, 0.345, 0.047);
const DARK = rgb(0.008, 0.024, 0.09);
const GRAY = rgb(0.4, 0.45, 0.55);
const LIGHT = rgb(0.97, 0.98, 0.99);

const SITE = "https://crm.denagocpt.co.za";

type Item = { description: string; qty: number; unitPriceCents: number };

export type SignedDocInput = {
  kind: "quote" | "jobcard";
  refNumber: string; // "Q-1004" | "#1023"
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  vehicleLine?: string | null;
  description?: string | null;
  items: Item[];
  termsLines: string[];
  signedByName: string;
  signedAt: Date;
  signerIp: string;
  signaturePng: Buffer; // the drawn signature
  dealerSignedByName?: string | null;
  dealerSignedAt?: Date | null;
  dealerSignatureUrl?: string | null; // Blob URL of the dealer's drawn signature
};

/** Builds a branded PDF of a signed quote/job card. */
export async function buildSignedPdf(input: SignedDocInput): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const M = 46;
  const W = 595 - M * 2;
  let y = 842 - 40;

  // Dark brand banner
  page.drawRectangle({ x: M, y: y - 64, width: W, height: 64, color: DARK });
  try {
    const logoBytes = await fetch(`${SITE}/branding/denago-logo-email.png`, { signal: AbortSignal.timeout(10_000) }).then((r) =>
      r.arrayBuffer()
    );
    const logo = await pdf.embedPng(logoBytes);
    const lh = 30;
    const lw = (logo.width / logo.height) * lh;
    page.drawImage(logo, { x: M + 18, y: y - 64 + (64 - lh) / 2, width: lw, height: lh });
  } catch {
    page.drawText("DENAGO CAPE TOWN EV", {
      x: M + 18, y: y - 40, size: 14, font: bold, color: rgb(1, 1, 1),
    });
  }
  const title = input.kind === "quote" ? "QUOTATION" : "JOB CARD";
  page.drawText(title, {
    x: M + W - 18 - bold.widthOfTextAtSize(title, 16),
    y: y - 30, size: 16, font: bold, color: rgb(1, 1, 1),
  });
  page.drawText(input.refNumber, {
    x: M + W - 18 - bold.widthOfTextAtSize(input.refNumber, 12),
    y: y - 48, size: 12, font: bold, color: ORANGE,
  });
  y -= 88;

  // Customer block
  page.drawText("PREPARED FOR", { x: M, y, size: 7, font: bold, color: ORANGE });
  y -= 14;
  page.drawText(input.customerName, { x: M, y, size: 11, font: bold, color: DARK });
  y -= 13;
  const contactLine = [input.customerPhone, input.customerEmail].filter(Boolean).join("  ·  ");
  if (contactLine) {
    page.drawText(contactLine, { x: M, y, size: 9, font, color: GRAY });
    y -= 12;
  }
  if (input.vehicleLine) {
    page.drawText(input.vehicleLine, { x: M, y, size: 9, font, color: GRAY });
    y -= 12;
  }
  y -= 8;

  if (input.description) {
    page.drawText("WORK REQUESTED", { x: M, y, size: 7, font: bold, color: GRAY });
    y -= 12;
    for (const line of wrap(input.description, 95).slice(0, 4)) {
      page.drawText(line, { x: M, y, size: 9, font, color: DARK });
      y -= 11;
    }
    y -= 6;
  }

  // Items table
  page.drawRectangle({ x: M, y: y - 18, width: W, height: 18, color: DARK });
  page.drawText("DESCRIPTION", { x: M + 8, y: y - 13, size: 7, font: bold, color: rgb(1, 1, 1) });
  page.drawText("QTY", { x: M + W - 190, y: y - 13, size: 7, font: bold, color: rgb(1, 1, 1) });
  page.drawText("UNIT", { x: M + W - 140, y: y - 13, size: 7, font: bold, color: rgb(1, 1, 1) });
  page.drawText("TOTAL", { x: M + W - 60, y: y - 13, size: 7, font: bold, color: rgb(1, 1, 1) });
  y -= 18;

  let total = 0;
  input.items.forEach((item, idx) => {
    const rowTotal = Math.round(item.qty * item.unitPriceCents);
    total += rowTotal;
    if (idx % 2 === 1) {
      page.drawRectangle({ x: M, y: y - 17, width: W, height: 17, color: LIGHT });
    }
    page.drawText(item.description.slice(0, 62), { x: M + 8, y: y - 12, size: 9, font, color: DARK });
    page.drawText(String(item.qty), { x: M + W - 190, y: y - 12, size: 9, font, color: DARK });
    page.drawText(formatZAR(item.unitPriceCents), { x: M + W - 140, y: y - 12, size: 8, font, color: DARK });
    page.drawText(formatZAR(rowTotal), { x: M + W - 60, y: y - 12, size: 8, font, color: DARK });
    y -= 17;
  });

  // Total band
  y -= 10;
  const totalText = `TOTAL INCL. VAT   ${formatZAR(total)}`;
  const bandW = bold.widthOfTextAtSize(totalText, 11) + 30;
  page.drawRectangle({ x: M + W - bandW, y: y - 24, width: bandW, height: 24, color: ORANGE });
  page.drawText(totalText, {
    x: M + W - bandW + 15, y: y - 17, size: 11, font: bold, color: rgb(1, 1, 1),
  });
  y -= 44;

  // Terms
  if (input.termsLines.length > 0) {
    page.drawText("TERMS", { x: M, y, size: 7, font: bold, color: GRAY });
    y -= 11;
    for (const t of input.termsLines) {
      for (const line of wrap(`•  ${t}`, 108)) {
        page.drawText(line, { x: M, y, size: 7.5, font, color: GRAY });
        y -= 10;
      }
    }
    y -= 10;
  }

  // Signature block
  page.drawText("SIGNED", { x: M, y, size: 7, font: bold, color: ORANGE });
  y -= 6;
  try {
    const sig = await pdf.embedPng(input.signaturePng);
    const sh = 60;
    const sw = Math.min((sig.width / sig.height) * sh, 220);
    page.drawImage(sig, { x: M, y: y - sh, width: sw, height: sh });
    y -= sh + 4;
  } catch {
    y -= 10;
  }
  page.drawLine({ start: { x: M, y }, end: { x: M + 240, y }, thickness: 1, color: DARK });
  y -= 12;
  page.drawText(
    `Signed electronically by ${input.signedByName} on ${formatDate(input.signedAt)} at ${input.signedAt.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })} (IP ${input.signerIp})`,
    { x: M, y, size: 8, font, color: GRAY }
  );

  // Denago countersignature — right-hand column beside the customer's
  if (input.dealerSignedByName) {
    const dx = M + 300;
    let dy = y + 12; // top of the customer's signature line
    if (input.dealerSignatureUrl) {
      try {
        const bytes = await fetch(input.dealerSignatureUrl, { signal: AbortSignal.timeout(10_000) }).then((r) => r.arrayBuffer());
        const sig = await pdf.embedPng(bytes);
        const sh = 44;
        const sw = Math.min((sig.width / sig.height) * sh, 180);
        page.drawImage(sig, { x: dx, y: dy + 4, width: sw, height: sh });
      } catch {}
    }
    page.drawLine({ start: { x: dx, y: dy }, end: { x: dx + 200, y: dy }, thickness: 1, color: DARK });
    dy -= 12;
    page.drawText(
      `For Denago Cape Town — ${input.dealerSignedByName}${
        input.dealerSignedAt ? `, ${formatDate(input.dealerSignedAt)}` : ""
      }`,
      { x: dx, y: dy, size: 8, font, color: GRAY }
    );
  }

  // Footer
  page.drawLine({ start: { x: M, y: 60 }, end: { x: M + W, y: 60 }, thickness: 1.5, color: ORANGE });
  page.drawText("Denago Cape Town — Authorized Denago EV Dealer", {
    x: M, y: 48, size: 8, font: bold, color: DARK,
  });
  page.drawText(
    "Unit 55, M5 Freeway Business Park, Maitland, Cape Town · 073 789 3438 · sales@denagocpt.co.za · denagocpt.co.za",
    { x: M, y: 37, size: 7, font, color: GRAY }
  );

  return Buffer.from(await pdf.save());
}

function wrap(text: string, chars: number): string[] {
  const words = text.replace(/\s+/g, " ").split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > chars) {
      lines.push(line.trim());
      line = w;
    } else {
      line = (line + " " + w).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}
