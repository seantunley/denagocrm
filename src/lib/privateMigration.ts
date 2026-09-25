import crypto from "node:crypto";
import { del, get, head, list, put } from "@vercel/blob";

/**
 * Moves every file from the PUBLIC Blob store into the PRIVATE one.
 *
 * SAME PATH, NO DATABASE WRITES. Each object is copied to the private store at
 * the identical pathname. The app reads by pathname, private store first
 * (readFile / openStoredFile / shareableFileUrl), so every existing reference —
 * including the append-only audit trail and the hashed legal-evidence manifests,
 * which must never be rewritten — keeps resolving to the same bytes. Nothing in
 * the database changes.
 *
 * VERIFY, THEN DELETE. The public copy is deleted only after the private copy
 * has been read back and its SHA-256 matches the public original. A mismatch or
 * any error leaves the public copy where it is, to be retried next run.
 *
 * Intentionally public images (campaign and bot-flow images, embedded in emails
 * and sent to WhatsApp by link) live under `uploads/<tenant>/public/` and are
 * left alone.
 *
 * Resumable and idempotent: it walks whatever is still public, so a run cut
 * short by its budget simply continues next time, and an object already copied
 * by an earlier run is verified rather than copied again.
 */

export const PUBLIC_ASSET = /^uploads\/[^/]+\/public\//;

export type StoredObject = { url: string; pathname: string };
export type MigrationIo = {
  listPublic: (cursor?: string) => Promise<{ blobs: StoredObject[]; cursor: string | null }>;
  readPublic: (url: string) => Promise<{ bytes: Buffer; contentType: string }>;
  existsPrivate: (pathname: string) => Promise<boolean>;
  writePrivate: (pathname: string, bytes: Buffer, contentType: string) => Promise<void>;
  readPrivate: (pathname: string) => Promise<Buffer>;
  deletePublic: (url: string) => Promise<void>;
};

export type MigrationPass = {
  moved: number;
  /** Copied by an earlier run; verified now and its public copy deleted. */
  verifiedEarlierCopy: number;
  keptPublicAssets: number;
  failed: Array<{ pathname: string; error: string }>;
  /** True when the whole public store was walked without stopping for budget. */
  walkedEverything: boolean;
};

const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

export async function movePublicFilesToPrivate(opts: {
  io: MigrationIo;
  shouldStop: () => boolean;
}): Promise<MigrationPass> {
  const { io, shouldStop } = opts;
  const pass: MigrationPass = { moved: 0, verifiedEarlierCopy: 0, keptPublicAssets: 0, failed: [], walkedEverything: false };
  let cursor: string | undefined;
  for (;;) {
    if (shouldStop()) return pass;
    const page = await io.listPublic(cursor);
    for (const object of page.blobs) {
      if (PUBLIC_ASSET.test(object.pathname)) {
        pass.keptPublicAssets++;
        continue;
      }
      if (shouldStop()) return pass;
      try {
        const source = await io.readPublic(object.url);
        const earlier = await io.existsPrivate(object.pathname);
        if (!earlier) await io.writePrivate(object.pathname, source.bytes, source.contentType);
        const copy = await io.readPrivate(object.pathname);
        if (sha256(copy) !== sha256(source.bytes)) {
          throw new Error("the private copy does not match the public original — public copy kept");
        }
        await io.deletePublic(object.url);
        if (earlier) pass.verifiedEarlierCopy++;
        else pass.moved++;
      } catch (error) {
        pass.failed.push({ pathname: object.pathname, error: error instanceof Error ? error.message.slice(0, 200) : "unknown error" });
      }
    }
    if (!page.cursor) {
      pass.walkedEverything = true;
      return pass;
    }
    cursor = page.cursor;
  }
}

/** Files still in the public store that should not be: everything except intentional public images. */
export async function countPublicClientFiles(io: Pick<MigrationIo, "listPublic">): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await io.listPublic(cursor);
    count += page.blobs.filter((b) => !PUBLIC_ASSET.test(b.pathname)).length;
    if (!page.cursor) return count;
    cursor = page.cursor;
  }
}

/** Largest object moved in one piece. The store's own upload limit is higher; nothing we hold is near it. */
const MAX_MOVE_BYTES = 200 * 1024 * 1024;

/** The real stores. Every call names its token (tests/blobCallsNameTheirStore). */
export function blobMigrationIo(publicToken: string, privateToken: string): MigrationIo {
  return {
    async listPublic(cursor) {
      const page = await list({ cursor, limit: 100, token: publicToken });
      return { blobs: page.blobs.map((b) => ({ url: b.url, pathname: b.pathname })), cursor: page.hasMore ? (page.cursor ?? null) : null };
    },
    async readPublic(url) {
      const meta = await head(url, { token: publicToken });
      if (meta.size > MAX_MOVE_BYTES) throw new Error(`too large to move in one piece (${meta.size} bytes)`);
      // Bounded: a store that stops answering must not hold the run to its platform limit.
      const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`public read failed: HTTP ${res.status}`);
      return { bytes: Buffer.from(await res.arrayBuffer()), contentType: meta.contentType || "application/octet-stream" };
    },
    async existsPrivate(pathname) {
      try {
        await head(pathname, { token: privateToken });
        return true;
      } catch {
        return false;
      }
    },
    async writePrivate(pathname, bytes, contentType) {
      await put(pathname, bytes, { access: "private", contentType, addRandomSuffix: false, allowOverwrite: false, token: privateToken });
    },
    async readPrivate(pathname) {
      const result = await get(pathname, { access: "private", token: privateToken, useCache: false });
      if (!result?.stream) throw new Error("private read returned nothing");
      const chunks: Buffer[] = [];
      const reader = result.stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    },
    async deletePublic(url) {
      await del(url, { token: publicToken });
    },
  };
}
