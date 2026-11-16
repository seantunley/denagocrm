import type { DocumentModel } from "@/lib/doceditor/model";

/**
 * How many pages a PDF has, counted from its page objects (Chromium writes them uncompressed). 0 when it can't tell
 * — which reads as "didn't fit", the safe answer.
 */
export function pdfPageCount(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
}

/**
 * THE STANDARD DELIVERY NOTE, SIGNED ON PAGE 1 WHEN IT FITS (Sean, 2026-11-16, DN-1037: "why all the white space").
 * The sign-off band — "Received in good order", signature, date, footer — sits at fixed coordinates, so it may only
 * go at the foot of page 1 when the note above it is known to end before it: rendered that way, the PDF is one page
 * (its flow keeps the band's room free, and anything longer breaks onto a second sheet). Otherwise the band goes on
 * a page 2 of its own. One render when it fits, two when it doesn't.
 */
export async function fitDeliveryNote(
  build: (signOff: "bottom" | "next-page") => DocumentModel,
  render: (doc: DocumentModel) => Promise<Buffer>,
): Promise<{ doc: DocumentModel; pdf: Buffer }> {
  const onePage = build("bottom");
  const pdf = await render(onePage);
  if (pdfPageCount(pdf) === 1) return { doc: onePage, pdf };
  const twoPages = build("next-page");
  return { doc: twoPages, pdf: await render(twoPages) };
}
