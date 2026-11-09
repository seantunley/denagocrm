/**
 * Asking a supplier for one of its papers through an upload link (2026-11-09, review section D). Pure: the rules
 * the staff action, the public page and the upload route share.
 */

export type DocumentRequestState = "open" | "received" | "recalled" | "expired";

/** Received wins (it happened); then recalled — the more useful thing to tell someone holding a dead link. */
export function documentRequestState(request: { expiresAt: Date; revokedAt: Date | null; fulfilledAt: Date | null }, now: Date): DocumentRequestState {
  if (request.fulfilledAt) return "received";
  if (request.revokedAt) return "recalled";
  return request.expiresAt <= now ? "expired" : "open";
}

/** How long a request link works: the same choices as a secure file link. */
export const REQUEST_DAYS = [3, 7, 14, 30] as const;
export const REQUEST_DEFAULT_DAYS = 7;
export const requestDays = (value: unknown): number => {
  const days = Number(value);
  return (REQUEST_DAYS as readonly number[]).includes(days) ? days : REQUEST_DEFAULT_DAYS;
};

/**
 * What a supplier may send: a PDF or a photo of the paper, up to 4 MB — the most a public upload can carry here
 * (the hosting's request-body limit), and plenty for an invoice. Checked by the file's own first bytes, not the
 * name or type the browser claims.
 */
export const REQUEST_MAX_BYTES = 4 * 1024 * 1024;

export function requestFileKind(head: Uint8Array): { mimeType: string; extension: string } | null {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => head[index] === byte);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return { mimeType: "application/pdf", extension: "pdf" }; // %PDF-
  if (starts(0xff, 0xd8, 0xff)) return { mimeType: "image/jpeg", extension: "jpg" };
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mimeType: "image/png", extension: "png" };
  if (starts(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) {
    return { mimeType: "image/webp", extension: "webp" }; // RIFF....WEBP
  }
  return null;
}

/** The file name the deal file shows: what it is and who sent it — never the supplier's own file name verbatim. */
export function requestedFileName(input: { documentType: string; vendorName: string; quoteNumber: number; extension: string }): string {
  const clean = (text: string) => text.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  return `${clean(input.documentType)} — ${clean(input.vendorName)} — Q-${input.quoteNumber}.${input.extension}`;
}

/** The email to the supplier: plain, and only what the supplier needs — never the customer's name. */
export function requestEmail(input: { brand: string; vendorName: string; documentType: string; quoteNumber: number; link: string; expiresLabel: string }): {
  subject: string;
  text: string;
} {
  const what = input.documentType.toLowerCase();
  return {
    subject: `${input.brand}: please upload your ${what} for Q-${input.quoteNumber}`,
    text: [
      `Hi ${input.vendorName},`,
      "",
      `Please upload your ${what} for our order Q-${input.quoteNumber} here:`,
      input.link,
      "",
      `The link works once, until ${input.expiresLabel}. A PDF or a photo of it, up to 4 MB.`,
      "",
      `Thank you,`,
      input.brand,
    ].join("\n"),
  };
}
