/**
 * What the document editor's image upload accepts. Pure, so the browser can
 * pre-check a file and a test can pin the rules; the server action re-checks.
 *
 * The type is read from the file's own first bytes, never from the name or the
 * browser-supplied MIME type — both are whatever the uploader says they are.
 * SVG is deliberately absent: it is a document that can carry script, and these
 * images are embedded in PDFs, signing pages and emails.
 */
export const DOC_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const DOC_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";

export function sniffDocImage(bytes: Uint8Array): { mime: string; ext: string } | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return { mime: "image/png", ext: "png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

/** The file's real type, or why it can't be used. `head` needs at least the first 12 bytes. */
export function checkDocImage(size: number, head: Uint8Array):
  { ok: true; mime: string; ext: string } | { ok: false; error: string } {
  if (size <= 0) return { ok: false, error: "Choose an image to upload." };
  if (size > DOC_IMAGE_MAX_BYTES) return { ok: false, error: "That image is over 5 MB. Use a smaller one." };
  const type = sniffDocImage(head);
  return type ? { ok: true, ...type } : { ok: false, error: "Only PNG, JPEG or WebP images can be uploaded." };
}
