import "server-only";
import { isStoredFileRef, readFile } from "./storage";

/** The image type from the first bytes; PNG when unrecognised (signatures are PNG). */
function imageType(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "image/png";
}

/**
 * A stored image as a `data:` URL, for printed documents.
 *
 * Signatures and template logos used to be printed with their storage link in
 * an <img>. A file in the private store has no public link, so the server reads
 * it (with the owner check readFile makes) and embeds the bytes instead — which
 * also keeps the printed page self-contained for Save as PDF.
 *
 * Anything that is not one of our stored files (a `/branding/…` asset, an outside
 * link, an existing data URL) is returned unchanged. A stored file that cannot be
 * read returns null, so the document prints without it rather than failing.
 */
export async function embedStoredImage(ref: string | null | undefined, tenantId?: string | null): Promise<string | null> {
  if (!ref) return null;
  if (!isStoredFileRef(ref)) return ref;
  try {
    const bytes = await readFile(ref, tenantId);
    return `data:${imageType(bytes)};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}
