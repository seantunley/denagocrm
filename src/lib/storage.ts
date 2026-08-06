import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { put, del, get, head, list } from "@vercel/blob";
import { activeStoreToken, activeWriteTokenPresent, dedupeByPathname } from "./backupBlobs";
import { currentTenantScope } from "./tenantScope";
import { isProductionRuntime } from "./signing/securityConfig";

const UPLOAD_DIR = path.join(process.cwd(), "storage", "uploads");
const BLOB_FETCH_TIMEOUT_MS = 20_000;
const privateMode = () => process.env.BLOB_PRIVATE === "true";
const publicToken = () => process.env.BLOB_READ_WRITE_TOKEN;
const privateToken = () => process.env.BLOB_PRIVATE_READ_WRITE_TOKEN;

const isPrivateBlobRef = (ref: string) => {
  try { return new URL(ref).hostname.endsWith(".private.blob.vercel-storage.com"); }
  catch { return false; }
};

function storagePrefix(): string {
  const tenantId = currentTenantScope()?.tenantId;
  return tenantId ? `tenants/${tenantId}/uploads` : "system/uploads";
}

/** Recover tenant ownership from the immutable object key when async scope is gone. */
function tenantFromRef(ref: string): string | null {
  try {
    const pathname = new URL(ref).pathname.replace(/^\/+/, "");
    const match = pathname.match(/^tenants\/([^/]+)\/uploads\//);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function saveFile(buffer: Buffer, originalName: string, contentType: string): Promise<string> {
  const ext = path.extname(originalName).slice(0, 12);
  const storedName = `${crypto.randomUUID()}${ext}`;
  const prefix = storagePrefix();
  const plannedObjectKey = `${prefix}/${storedName}`;
  const production = isProductionRuntime();
  const tenantId = currentTenantScope()?.tenantId ?? null;
  const custody = tenantId ? await import("./signing/artifactCustody") : null;
  const intentId = tenantId && custody
    ? await custody.beginUploadIntent({ tenantId, plannedObjectKey, originalName, mimeType: contentType })
    : null;
  try {
    if (production && (!privateMode() || !privateToken())) {
      throw new Error("Production file writes require private Blob storage; public/local fallback is disabled");
    }
    let ref: string;
    if (privateMode()) {
      const token = privateToken();
      if (!token) throw new Error("BLOB_PRIVATE=true requires BLOB_PRIVATE_READ_WRITE_TOKEN");
      const blob = await put(plannedObjectKey, buffer, { access: "private", contentType, addRandomSuffix: false, token });
      ref = blob.url;
    } else if (publicToken()) {
      if (production) throw new Error("Public Blob writes are forbidden for production signing/storage");
      const blob = await put(plannedObjectKey, buffer, { access: "public", contentType, addRandomSuffix: false });
      ref = blob.url;
    } else {
      if (production) throw new Error("Local-disk storage is forbidden in production");
      await fs.mkdir(UPLOAD_DIR, { recursive: true });
      await fs.writeFile(path.join(UPLOAD_DIR, storedName), buffer);
      ref = storedName;
    }
    if (custody) await custody.completeUploadIntent({ id: intentId, objectRef: ref, bytes: buffer });
    return ref;
  } catch (error) {
    if (custody) await custody.failUploadIntent(intentId, error);
    throw error;
  }
}

const BLOB_HOST = /(^|\.)blob\.vercel-storage\.com$/i;
function isTrustedBlobRef(ref: string): boolean {
  try { const u = new URL(ref); return u.protocol === "https:" && BLOB_HOST.test(u.hostname); }
  catch { return false; }
}

export const MAX_BLOB_BYTES = Number(process.env.MAX_BLOB_READ_BYTES ?? 64 * 1024 * 1024);
export class BlobTooLargeError extends Error {}
export type OwnedBlob = { size: number; contentType: string; pathname: string };

export async function assertOwnedBlob(ref: string): Promise<OwnedBlob> {
  if (!isTrustedBlobRef(ref)) throw new Error("Refusing a storage reference that is not a Blob URL");
  const tokens = [privateToken(), publicToken()].filter((v): v is string => Boolean(v));
  if (!tokens.length) throw new Error("Blob storage is not configured");
  for (const token of tokens) {
    try {
      const meta = await head(ref, { token });
      return { size: meta.size, contentType: meta.contentType, pathname: meta.pathname };
    } catch { /* try other owned store */ }
  }
  throw new Error("Refusing a Blob URL that is not in our store");
}

function isLocalRef(ref: string): boolean {
  return ref.length > 0 && !ref.includes("/") && !ref.includes("\\") && !ref.includes("\0") && ref !== "." && ref !== ".." && !path.isAbsolute(ref);
}

function classifyRef(ref: string): "blob" | "local" {
  if (isTrustedBlobRef(ref)) return "blob";
  if (isLocalRef(ref)) return "local";
  throw new Error("Refusing an unrecognised storage reference");
}
const isBlobRef = (ref: string) => classifyRef(ref) === "blob";

export function directReadUrl(ref: string): string | null {
  if (!isTrustedBlobRef(ref) || isPrivateBlobRef(ref)) return null;
  return ref;
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>, cap = MAX_BLOB_BYTES): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new BlobTooLargeError(`Refusing to read more than ${cap} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function readFile(ref: string): Promise<Buffer> {
  if (!isBlobRef(ref)) return fs.readFile(path.join(UPLOAD_DIR, ref));
  if (privateToken()) {
    try {
      const pathname = new URL(ref).pathname.replace(/^\/+/, "");
      const result = await get(pathname, { access: "private", token: privateToken() });
      if (result?.stream) return streamToBuffer(result.stream);
    } catch (error) {
      if (error instanceof BlobTooLargeError) throw error;
    }
  }
  const meta = await assertOwnedBlob(ref);
  if (meta.size > MAX_BLOB_BYTES) throw new BlobTooLargeError(`Blob exceeds ${MAX_BLOB_BYTES} bytes`);
  const response = await fetch(ref, { signal: AbortSignal.timeout(BLOB_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Blob fetch failed: ${response.status}`);
  return response.body ? streamToBuffer(response.body) : Buffer.alloc(0);
}

async function rawDeleteFile(ref: string): Promise<void> {
  if (isBlobRef(ref)) {
    const token = isPrivateBlobRef(ref) ? privateToken() : publicToken();
    if (!token) throw new Error("No token available for the object's Blob store");
    await del(ref, { token });
    return;
  }
  await fs.unlink(path.join(UPLOAD_DIR, ref)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

/**
 * Retain-not-delete compensation. This function never removes bytes. Once the
 * reference check proves the object is presently unreferenced it records an
 * orphan candidate for a later settlement-period collector. If ownership cannot
 * be recovered, the object is retained and surfaced for reconciliation.
 */
export async function deleteFile(ref: string): Promise<void> {
  const { isStorageRefReferenced, scheduleOrphanSettlement } = await import("./signing/artifactCustody");
  if (await isStorageRefReferenced(ref)) {
    console.warn("[storage] retained referenced object", ref);
    return;
  }
  const tenantId = currentTenantScope()?.tenantId ?? tenantFromRef(ref);
  if (!tenantId) {
    console.error("[storage] retained unclassified object; no tenant could be established", ref);
    return;
  }
  await scheduleOrphanSettlement(ref, tenantId);
}

/** Only the settlement-period orphan collector and storage self-test may bypass reference checks. */
export async function deleteVerifiedOrphan(ref: string): Promise<void> {
  const { isStorageRefReferenced } = await import("./signing/artifactCustody");
  if (await isStorageRefReferenced(ref)) throw new Error("Refusing to purge a referenced object");
  await rawDeleteFile(ref);
}

/** Delete bytes only under an approved, independent legal-destruction workflow. */
export async function deleteApprovedLegalObject(ref: string, requestId: string, tenantId: string): Promise<void> {
  const { isApprovedLegalDestruction } = await import("./signing/artifactCustody");
  if (!(await isApprovedLegalDestruction(ref, requestId, tenantId))) {
    throw new Error("Legal-artifact deletion is not independently approved");
  }
  await rawDeleteFile(ref);
}

export async function verifyPrivateStorage(): Promise<void> {
  if (!privateMode() || !privateToken()) throw new Error("Private Blob storage is not configured");
  const marker = Buffer.from(`denago-signing-storage-self-test:${Date.now()}`);
  const ref = await saveFile(marker, "signing-storage-self-test.txt", "text/plain");
  const readBack = await readFile(ref);
  if (!crypto.timingSafeEqual(marker, readBack)) throw new Error("Private Blob storage self-test returned different bytes");
  await rawDeleteFile(ref);
}

const storeTokens = () => ({ publicToken: publicToken(), privateToken: privateToken() });
export function activeBlobWriteTokenPresent(): boolean {
  return activeWriteTokenPresent(privateMode(), storeTokens());
}

export async function putManagedBlob(pathname: string, data: Buffer | string, contentType: string): Promise<{ url: string; pathname: string }> {
  if (isProductionRuntime() && (!privateMode() || !privateToken())) throw new Error("Production managed objects require private Blob storage");
  if (privateMode()) {
    const token = privateToken();
    if (!token) throw new Error("BLOB_PRIVATE=true requires BLOB_PRIVATE_READ_WRITE_TOKEN");
    const blob = await put(pathname, data, { access: "private", contentType, addRandomSuffix: false, allowOverwrite: false, token });
    return { url: blob.url, pathname: blob.pathname };
  }
  if (!publicToken()) throw new Error("Blob storage is not configured");
  const blob = await put(pathname, data, { access: "public", contentType, addRandomSuffix: false, allowOverwrite: false });
  return { url: blob.url, pathname: blob.pathname };
}

async function collectBlobs(prefix: string, token: string): Promise<Array<{ pathname: string; url: string }>> {
  const output: Array<{ pathname: string; url: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000, token });
    output.push(...page.blobs.map((blob) => ({ pathname: blob.pathname, url: blob.url })));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return output;
}

export async function listActiveBackupBlobs(prefix: string): Promise<Array<{ pathname: string; url: string }>> {
  const token = activeStoreToken(privateMode(), storeTokens());
  return token ? collectBlobs(prefix, token) : [];
}

export async function listAllBackupBlobs(prefix: string): Promise<Array<{ pathname: string; url: string }>> {
  const pub = publicToken() ? await collectBlobs(prefix, publicToken()!) : [];
  const priv = privateToken() ? await collectBlobs(prefix, privateToken()!) : [];
  return dedupeByPathname(pub, priv);
}
