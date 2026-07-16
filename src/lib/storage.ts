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
 * direct public URL. Vercel Blob access is configured at the STORE level, so a
 * private blob belongs in a dedicated private store with its own token. When
 * BLOB_PRIVATE=true AND BLOB_PRIVATE_READ_WRITE_TOKEN is set, new uploads are
 * written to the private store; reads try the private store (authenticated get())
 * first and fall back to a public fetch, so legacy public blobs keep working. The
 * flag is opt-in so it can be verified on a preview deployment before flipping
 * production; existing public blobs are then migrated (scripts/migrate-blobs-private).
 */

const UPLOAD_DIR = path.join(process.cwd(), "storage", "uploads");

const privateMode = () => process.env.BLOB_PRIVATE === "true";
const publicToken = () => process.env.BLOB_READ_WRITE_TOKEN;
const privateToken = () => process.env.BLOB_PRIVATE_READ_WRITE_TOKEN;

// A blob served from a private store lives on a `*.private.blob.vercel-storage.com`
// host; a legacy public blob lives on `*.blob.vercel-storage.com`. Deletion must use
// the token for the store the object actually lives in — the SDK otherwise defaults to
// OIDC / BLOB_READ_WRITE_TOKEN and would silently no-op on a private object.
const isPrivateBlobRef = (ref: string) => {
  try {
    return new URL(ref).hostname.endsWith(".private.blob.vercel-storage.com");
  } catch {
    return false;
  }
};

export async function saveFile(
  buffer: Buffer,
  originalName: string,
  contentType: string
): Promise<string> {
  const ext = path.extname(originalName).slice(0, 12);
  const storedName = crypto.randomUUID() + ext;

  // Private mode fails CLOSED: if the flag is on we must have a private-store token,
  // otherwise we'd either write a "private" file into a public store or fall through
  // to local disk — both silently defeat the privacy guarantee. Throw instead.
  if (privateMode()) {
    const token = privateToken();
    if (!token) {
      throw new Error("BLOB_PRIVATE=true requires BLOB_PRIVATE_READ_WRITE_TOKEN");
    }
    const blob = await put(`uploads/${storedName}`, buffer, {
      access: "private",
      contentType,
      addRandomSuffix: false,
      token,
    });
    return blob.url;
  }

  if (publicToken()) {
    const blob = await put(`uploads/${storedName}`, buffer, {
      access: "public", // unguessable URL; downloads still go through our auth route
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
    // Authenticated read from the private store first (blobs written there); fall
    // back to a public fetch for legacy public blobs.
    if (privateToken()) {
      try {
        const pathname = new URL(ref).pathname.replace(/^\/+/, "");
        const result = await get(pathname, { access: "private", token: privateToken() });
        if (result?.stream) return await streamToBuffer(result.stream);
      } catch {
        // Not in the private store (or unavailable) → try the public path.
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
    // Pick the token for the store the object lives in. A private-file deletion
    // failure is NOT swallowed — a leaked private object is a real problem.
    const token = isPrivateBlobRef(ref) ? privateToken() : publicToken();
    if (!token) {
      throw new Error(`No Blob token available to delete ${isPrivateBlobRef(ref) ? "private" : "public"} object`);
    }
    await del(ref, { token });
    return;
  }
  await fs.unlink(path.join(UPLOAD_DIR, ref)).catch(() => {});
}
