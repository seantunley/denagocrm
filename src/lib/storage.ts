import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { put, del } from "@vercel/blob";

/**
 * Document storage that works in both deployment modes:
 * - Vercel (BLOB_READ_WRITE_TOKEN set): files live in Vercel Blob; the stored
 *   reference is the blob URL (unguessable, and always proxied through our
 *   authenticated /api/files route).
 * - Self-hosted / local dev: files live on disk under storage/uploads and the
 *   stored reference is the random file name.
 */

const UPLOAD_DIR = path.join(process.cwd(), "storage", "uploads");

const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

export async function saveFile(
  buffer: Buffer,
  originalName: string,
  contentType: string
): Promise<string> {
  const ext = path.extname(originalName).slice(0, 12);
  const storedName = crypto.randomUUID() + ext;

  if (useBlob()) {
    const blob = await put(`uploads/${storedName}`, buffer, {
      access: "public", // public = unguessable URL; downloads still go through our auth route
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

export async function readFile(ref: string): Promise<Buffer> {
  if (isBlobRef(ref)) {
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
