import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { put, del, get } from "@vercel/blob";

/**
 * Document storage that works in both deployment modes:
 * - Vercel (BLOB_READ_WRITE_TOKEN set): files live in Vercel Blob. All downloads
 *   go through our authenticated /api/files route, which streams via readFile().
 * - Self-hosted / local dev: files live on disk under storage/uploads.
 *
 * PRIVATE STORAGE (staged rollout): sensitive assets must not be reachable by a
 * direct public URL. When BLOB_PRIVATE=true, new uploads are written with
 * access:"private" (reachable only through the authenticated get() API). readFile
 * always attempts a private, authenticated read first and falls back to a public
 * fetch, so legacy public blobs keep working. The flag is opt-in so it can be
 * verified on a preview deployment before flipping production; then existing
 * public blobs are migrated (scripts/migrate-blobs-private — see PR notes).
 */

const UPLOAD_DIR = path.join(process.cwd(), "storage", "uploads");

const blobConfigured = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const blobPrivate = () => process.env.BLOB_PRIVATE === "true";

export async function saveFile(
  buffer: Buffer,
  originalName: string,
  contentType: string
): Promise<string> {
  const ext = path.extname(originalName).slice(0, 12);
  const storedName = crypto.randomUUID() + ext;

  if (blobConfigured()) {
    const blob = await put(`uploads/${storedName}`, buffer, {
      access: blobPrivate() ? "private" : "public",
      contentType,
      addRandomSuffix: false,
    });
    return blob.url;
  }

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, storedName), buffer);
  return storedName;
}

const isBlobRef = (ref: string) => ref.startsWith("https://");

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function readFile(ref: string): Promise<Buffer> {
  if (isBlobRef(ref)) {
    // Authenticated private read first (blobs written with access:"private");
    // fall back to a public fetch for legacy public blobs.
    if (blobConfigured()) {
      try {
        const pathname = new URL(ref).pathname.replace(/^\/+/, "");
        const result = await get(pathname, { access: "private", token: process.env.BLOB_READ_WRITE_TOKEN });
        if (result?.stream) return await streamToBuffer(result.stream);
      } catch {
        // Not a private blob (or unavailable as private) → try the public path.
      }
    }
    const res = await fetch(ref);
    if (!res.ok) throw new Error(`Blob fetch failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.readFile(path.join(UPLOAD_DIR, ref));
}

export async function deleteFile(ref: string): Promise<void> {
  if (isBlobRef(ref)) {
    await del(ref).catch(() => {});
    return;
  }
  await fs.unlink(path.join(UPLOAD_DIR, ref)).catch(() => {});
}
