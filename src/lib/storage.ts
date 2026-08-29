import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { put, del, get, head, list } from "@vercel/blob";
import {
  activeStoreToken,
  activeWriteTokenPresent,
  dedupeByPathname,
} from "./backupBlobs";
import { DEFAULT_TENANT_ID } from "./tenant";

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

/** How long a Blob read may take. Node fetch has no default timeout, and a size
 *  cap says nothing about a host that connects and then never sends a byte. */
const BLOB_FETCH_TIMEOUT_MS = 20_000;

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

/**
 * Store an uploaded file and return its ref.
 *
 * `tenantId` namespaces the object as `uploads/<tenantId>/<uuid><ext>`, which is
 * what lets {@link assertOwnedBlob} answer "is this yours?" rather than only "is
 * this ours?".
 *
 * WHO TO PASS. The record the upload BELONGS TO, where there is one — a job-card
 * photo belongs to the job card, a quote's invoice to the quote, a portal upload
 * to the contact — and its `tenantId` VERBATIM. Only where there is genuinely no
 * parent does the ACTING workspace decide (`actingOwnerTenantId()`).
 *
 * NULL IS AN ANSWER, which is why the parameter takes it rather than only
 * `undefined`. Production is full of rows written before stamping, and a parent
 * that is itself unowned cannot confer an owner: substituting one would be the
 * `?? DEFAULT_TENANT_ID` defect that #463 removed, in a new place. An unowned
 * parent yields the legacy flat path, which {@link blobBelongsToTenant} attributes
 * to the founding tenant — the same object, in the same place, as before this
 * change. Nothing is invented and nothing moves.
 *
 * The store is shared and objects are written `access: "public"` unless
 * BLOB_PRIVATE is on, so the URL is the only secret. Namespacing does not change
 * that; it stops a KNOWN url being re-registered by another workspace. Turning on
 * BLOB_PRIVATE is the separate, larger half — see the PR.
 */
export async function saveFile(
  buffer: Buffer,
  originalName: string,
  contentType: string,
  tenantId?: string | null
): Promise<string> {
  const ext = path.extname(originalName).slice(0, 12);
  const localName = crypto.randomUUID() + ext;
  // Blob objects are namespaced by workspace; the LOCAL disk fallback is not.
  // A local ref is a bare filename by contract (`isLocalRef` rejects anything
  // containing a slash), and local storage only runs in single-workspace dev, so
  // namespacing it would break the ref format for no isolation gain.
  const storedName = tenantId ? `${tenantId}/${localName}` : localName;

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
  await fs.writeFile(path.join(UPLOAD_DIR, localName), buffer);
  return localName;
}

/**
 * A storage ref is EITHER a Vercel Blob URL we wrote, OR a bare local filename
 * that saveFile generated. Nothing else, ever.
 *
 * This used to be `ref.startsWith("https://")`, with everything else handed to
 * `path.join(UPLOAD_DIR, ref)` and every https ref handed to `fetch`. Both
 * branches trusted the ref completely, which was fine while every ref came from
 * saveFile — and stopped being fine the moment one caller stored a
 * client-supplied URL (registerLibraryDocuments). That turned a ref into two
 * primitives: `../../../../proc/self/environ` read any file the function could
 * see, and `https://anything` made the server fetch it and hand back the body.
 *
 * Validating at the read/delete boundary rather than only at that one caller is
 * deliberate: it protects the next caller too, and there are twenty write sites.
 */
const BLOB_HOST = /(^|\.)blob\.vercel-storage\.com$/i;

/**
 * Shape check only: an https URL on the Vercel Blob service. It does NOT say the
 * object is ours — every Vercel customer's store lives under this suffix, so a
 * hostname match proves the vendor and nothing else. Ownership is decided by
 * {@link assertOwnedBlob}, which asks OUR store.
 */
function isTrustedBlobRef(ref: string): boolean {
  try {
    const url = new URL(ref);
    return url.protocol === "https:" && BLOB_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Largest object we will pull into memory. Enforced twice, deliberately: against
 * the size the store reports, and again while reading, because a Content-Length
 * is a claim and a stream is a fact.
 */
export const MAX_BLOB_BYTES = Number(process.env.MAX_BLOB_READ_BYTES ?? 64 * 1024 * 1024);

/** Thrown by the cap so the private-store fallback can tell it from a miss. */
export class BlobTooLargeError extends Error {}

export type OwnedBlob = { size: number; contentType: string; pathname: string };

/**
 * Prove a Blob URL is in a store we hold a token for, and return the size and
 * content type the STORE reports.
 *
 * A hostname allowlist cannot do this. `*.blob.vercel-storage.com` is every
 * Vercel customer's store, so `registerLibraryDocuments` — which takes the URL
 * and its size/type from the client — could point a library document at a
 * stranger's bucket with any metadata it liked, and the server would later fetch
 * it. `head()` resolves through OUR token, so an object in another store is a
 * miss, and the size it returns is the server's number rather than the caller's.
 *
 * OURS IS NOT YOURS. That check proves the object is in OUR store, and our store
 * is ONE store shared by every workspace. So a library manager in workspace B who
 * has come by a blob URL belonging to workspace A — a forwarded email, a pasted
 * link, a screenshot, browser history — could register A's file into B's library
 * and then download it through B's own authorised route. The vendor check proves
 * the vendor; the store check proves the store; neither proves the owner.
 *
 * Pass `expectedTenantId` to close that. New uploads are written under
 * `uploads/<tenantId>/…` (see {@link saveFile}), so the pathname the store
 * reports is itself the ownership claim, and it comes from the store rather than
 * from the caller.
 */
export async function assertOwnedBlob(ref: string, expectedTenantId?: string | null): Promise<OwnedBlob> {
  if (!isTrustedBlobRef(ref)) throw new Error("Refusing a storage reference that is not a Blob URL");
  const tokens = [privateToken(), publicToken()].filter((t): t is string => Boolean(t));
  if (tokens.length === 0) throw new Error("Blob storage is not configured");
  for (const token of tokens) {
    try {
      const meta = await head(ref, { token });
      if (!ownedByExpected(meta.pathname, expectedTenantId)) {
        throw new BlobNotYoursError("Refusing a stored file that belongs to another workspace");
      }
      return { size: meta.size, contentType: meta.contentType, pathname: meta.pathname };
    } catch (error) {
      // A cross-tenant refusal is a verdict, not a miss — it must not fall
      // through to "try the other store" and end up reported as "not ours".
      if (error instanceof BlobNotYoursError) throw error;
      // Not in this store — try the other one, then refuse.
    }
  }
  throw new Error("Refusing a Blob URL that is not in our store");
}

/** Distinguishes "belongs to another workspace" from "not in our store at all". */
export class BlobNotYoursError extends Error {}

/**
 * Does this stored object belong to `tenantId`?
 *
 * New objects live at `uploads/<tenantId>/<uuid><ext>`, so the answer is in the
 * path. Legacy objects predate the namespace and have no tenant segment.
 *
 * LEGACY RULE, and why it is sound here rather than the unsafe rule we removed
 * elsewhere: production has only ever had ONE tenant, so every object written
 * before namespacing necessarily belongs to the founding tenant. That is a fact
 * about the deployment's history, not an assumption about a NULL. It stops being
 * true the moment a second workspace uploads anything — which is exactly when
 * namespacing starts applying, so no un-namespaced object can ever be ambiguous.
 */
export function blobBelongsToTenant(pathname: string, tenantId: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  // uploads/<tenantId>/<file>  — the namespaced form.
  if (segments.length >= 3 && segments[0] === "uploads") return segments[1] === tenantId;
  // uploads/<file> — legacy, founding tenant only.
  if (segments.length === 2 && segments[0] === "uploads") return tenantId === DEFAULT_TENANT_ID;
  // Anything else (backups, managed paths) is not a per-tenant upload; those
  // callers do not pass an expected tenant and never reach this.
  return false;
}

/**
 * {@link blobBelongsToTenant} with the "caller made no claim" case folded in, so
 * the two enforcement points ({@link assertOwnedBlob} and {@link readFile}'s
 * private branch) cannot drift on the one decision that matters.
 *
 * Absent expectation → true. That is the pre-existing behaviour, and it is the
 * honest one: an unowned record has no owner to compare against, and inventing
 * the viewer's would refuse a legitimate download rather than prevent an illicit
 * one. See {@link readFile}.
 */
function ownedByExpected(pathname: string, expectedTenantId?: string | null): boolean {
  if (!expectedTenantId) return true;
  return blobBelongsToTenant(pathname, expectedTenantId);
}

/** A bare filename — no directory component, no traversal, not absolute. */
function isLocalRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    !ref.includes("/") &&
    !ref.includes("\\") &&
    !ref.includes("\0") &&
    ref !== "." &&
    ref !== ".." &&
    !path.isAbsolute(ref)
  );
}

/**
 * Classify a ref, or refuse it. Throwing beats returning a boolean here: a
 * caller that forgets to check would otherwise fall through to the local
 * branch, which is the dangerous one.
 */
function classifyRef(ref: string): "blob" | "local" {
  if (isTrustedBlobRef(ref)) return "blob";
  if (isLocalRef(ref)) return "local";
  throw new Error("Refusing an unrecognised storage reference");
}

const isBlobRef = (ref: string) => classifyRef(ref) === "blob";

/**
 * A URL the BROWSER can load for itself, or null when the bytes have to be
 * proxied through us.
 *
 * Only a legacy PUBLIC Blob object qualifies: a private blob needs our token,
 * and a local filename is not addressable from outside at all. Rendering an
 * <img> is the use — readFile() would otherwise pull the whole object through
 * the server for no reason, and fail outright in an environment with no Blob
 * token configured, which is every local checkout.
 *
 * Deciding it HERE rather than in the caller keeps the ref-shape rules in the
 * one module that owns them; a caller doing `ref.startsWith("http")` is exactly
 * the check this module's comments explain the cost of.
 */
export function directReadUrl(ref: string): string | null {
  if (!isTrustedBlobRef(ref) || isPrivateBlobRef(ref)) return null;
  return ref;
}

/**
 * Read a stream into memory, refusing to exceed `cap`.
 *
 * The cap is checked per chunk rather than from a header: `arrayBuffer()` (what
 * this replaces) buffers whatever arrives, so a large or unbounded object was an
 * out-of-memory lever on a route any authenticated caller could trigger.
 */
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
      throw new BlobTooLargeError(`Refusing to read more than ${cap} bytes from Blob storage`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Read a stored object.
 *
 * `expectedTenantId` is the OTHER HALF of {@link saveFile}'s namespace. A
 * namespaced write with an unvalidated read is half a fix: the object now says
 * whose it is, and nothing asks. Pass the owner of the RECORD the ref came off —
 * `doc.tenantId`, `asset.tenantId`, `upload.tenantId` — and a ref pointing at
 * another workspace's object is refused with {@link BlobNotYoursError}.
 *
 * NULL/UNDEFINED MEANS "NO CLAIM TO CHECK", not "any owner will do". Most rows in
 * production are still unowned, and a record that does not know its own workspace
 * cannot say who its file belongs to; asserting one from the viewer's session
 * instead would refuse legitimate downloads the moment a second workspace exists.
 * So an unowned record reads exactly as it does today, and an OWNED one is
 * checked — the check strengthens by itself as stamping and backfill land, with
 * no second pass over these routes.
 *
 * Both branches are covered deliberately. The private-store branch returns bytes
 * WITHOUT reaching assertOwnedBlob — reaching that store proves the STORE, which
 * is the exact distinction #474 was about — so it is checked here, against the
 * pathname it is about to fetch, before it fetches it.
 */
export async function readFile(ref: string, expectedTenantId?: string | null): Promise<Buffer> {
  if (!isBlobRef(ref)) return fs.readFile(path.join(UPLOAD_DIR, ref));

  // Authenticated read from the private store first (blobs written there); fall
  // back to a public fetch for legacy public blobs. Reaching the private store
  // with our own token is itself proof of ownership.
  if (privateToken()) {
    try {
      const pathname = new URL(ref).pathname.replace(/^\/+/, "");
      // The pathname IS the object's location, so checking it before the get is
      // checking the object we are about to read: a ref naming another
      // workspace's prefix cannot be made to yield ours, and one naming ours
      // cannot yield theirs. The catch below rethrows the refusal rather than
      // treating it as a miss — falling through to the public branch would
      // re-ask for the same forbidden object and report it as "not ours".
      if (!ownedByExpected(pathname, expectedTenantId)) {
        throw new BlobNotYoursError("Refusing a stored file that belongs to another workspace");
      }
      const result = await get(pathname, { access: "private", token: privateToken() });
      if (result?.stream) return await streamToBuffer(result.stream);
    } catch (error) {
      if (error instanceof BlobNotYoursError) throw error;
      // A miss means "try the public path". The cap is NOT a miss — swallowing it
      // here would re-download the same oversized object over the public route.
      if (error instanceof BlobTooLargeError) throw error;
    }
  }

  // Public path: ask OUR store first. This both proves the object is ours — a
  // hostname match does not, every Vercel store shares that suffix — and yields
  // an authoritative size, so an oversized object is refused before a byte of it
  // is fetched rather than after it is already in memory.
  const meta = await assertOwnedBlob(ref, expectedTenantId);
  if (meta.size > MAX_BLOB_BYTES) {
    throw new BlobTooLargeError(`Blob is ${meta.size} bytes, over the ${MAX_BLOB_BYTES}-byte read limit`);
  }
  const res = await fetch(ref, { signal: AbortSignal.timeout(BLOB_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Blob fetch failed: ${res.status}`);
  if (!res.body) return Buffer.alloc(0);
  return streamToBuffer(res.body);
}

/**
 * A pathname as {@link putManagedBlob} returns it: folder segments inside our
 * own store. Returns the value rather than a boolean, for classifyRef's reason —
 * a caller cannot use the result without having gone through the check.
 *
 * Everything readFile's local branch is dangerous about is refused here: no
 * traversal, no absolute path, no backslash or NUL, no empty segment. A scheme
 * is refused too, because a URL is {@link readFile}'s business, not this one's.
 */
export function managedBlobPathname(ref: string | null | undefined): string | null {
  const value = (ref ?? "").trim();
  if (!value || value.includes("\0") || value.includes("\\")) return null;
  if (value.startsWith("/") || path.isAbsolute(value)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return value;
}

/**
 * Read a blob WE wrote, addressed by the pathname {@link putManagedBlob}
 * returned rather than by its URL.
 *
 * Why this exists alongside readFile(): a ref naming a FOLDER PATH is neither of
 * readFile's two shapes — not a Blob URL, not a bare filename — so classifyRef
 * refuses it outright. Tenant branding stores exactly that shape deliberately:
 * `branding/<tenantId>/logo-<stamp>.<ext>` is what lets the public logo route
 * REBUILD a path from the tenant id and a validated filename instead of trusting
 * anything in the request, and what keeps a logo frozen into a signed document
 * resolvable after the tenant rebrands.
 *
 * The two halves disagreed in production: the upload wrote a ref the reader
 * could never read, so every tenant logo 404'd and the sidebar showed a broken
 * image. The stored refs are correct — the reader for them was missing.
 *
 * There is deliberately NO local-disk branch. putManagedBlob has none either (it
 * throws without a token), so a managed blob is never on disk, and adding one
 * would hand a slashed path to path.join() — the single thing classifyRef exists
 * to prevent.
 */
export async function readManagedBlob(ref: string): Promise<Buffer> {
  const pathname = managedBlobPathname(ref);
  if (!pathname) throw new Error("Refusing an unrecognised managed blob pathname");

  // The private store answers by pathname directly, and reaching it with our own
  // token is itself the proof of ownership.
  const privately = privateToken();
  if (privately) {
    try {
      const result = await get(pathname, { access: "private", token: privately });
      if (result?.stream) return await streamToBuffer(result.stream);
    } catch (error) {
      // A miss means the object predates private mode — try the public store.
      // The cap is not a miss; re-reading over the public route would fetch the
      // same oversized object again.
      if (error instanceof BlobTooLargeError) throw error;
    }
  }

  // The public store has no read-by-pathname, so resolve the pathname to the URL
  // OUR store reports and read THAT through readFile — which re-proves ownership
  // and applies the size cap, rather than duplicating either here. An exact
  // match, not the prefix: `list` would also return `…/logo-1.png.bak`.
  const publicly = publicToken();
  if (publicly) {
    const match = (await collectBlobs(pathname, publicly)).find((blob) => blob.pathname === pathname);
    if (match) return readFile(match.url);
  }

  throw new Error("Managed blob not found");
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

/**
 * May this stored object be deleted as cleanup for `requiredPrefix`?
 *
 * Pure, so the rule can be exercised directly rather than inferred from a call
 * site. Both halves are load-bearing: ownership answers "is this the caller's
 * workspace's object", the prefix answers "is it the one this record just
 * staged" — a caller must not be able to tidy away an unrelated file of its own.
 */
export function mayCleanUpStoredBlob(pathname: string, tenantId: string, requiredPrefix: string): boolean {
  if (!requiredPrefix) return false;
  return blobBelongsToTenant(pathname, tenantId) && pathname.startsWith(requiredPrefix);
}

/**
 * Delete a staged upload ONLY after proving it belongs to `tenantId` and to the
 * record identified by `requiredPrefix`.
 *
 * WHY THIS EXISTS, and why cleanup must never call {@link deleteFile} directly
 * on a client-supplied URL. The register* actions take blob URLs from the
 * browser, verify each with {@link assertOwnedBlob}, and file it. Verification
 * failure threw into a catch whose job was to tidy up the staged object — so a
 * URL REJECTED as belonging to another workspace was handed straight to
 * deleteFile, which has no tenant check and deletes with the application's own
 * credentials. The cleanup path therefore undid the very protection the
 * ownership check had just applied: any user who could stage a photo on their
 * own record could delete another workspace's file by pasting its URL.
 *
 * Ordering it as verify-then-delete inside one helper is deliberate. A boolean
 * flag at the call site would work until someone restructured the try/catch;
 * here a caller cannot express the unsafe operation at all.
 *
 * `io` is a test seam in the style of {@link photoBlobAccess}'s `env` — the
 * refusal path is the security boundary, so it has to be executable in a test
 * without a Blob store to talk to.
 */
export async function deleteOwnedBlob(
  ref: string,
  tenantId: string,
  requiredPrefix: string,
  io: {
    verify: (ref: string, tenantId?: string | null) => Promise<OwnedBlob>;
    remove: (ref: string) => Promise<void>;
  } = { verify: assertOwnedBlob, remove: deleteFile },
): Promise<void> {
  const blob = await io.verify(ref, tenantId);
  if (!mayCleanUpStoredBlob(blob.pathname, tenantId, requiredPrefix)) {
    throw new Error("Refusing to delete a stored file that is not bound to this record");
  }
  await io.remove(ref);
}

const storeTokens = () => ({ publicToken: publicToken(), privateToken: privateToken() });

/** Whether the store we currently WRITE to has a usable token (see backupBlobs). */
export function activeBlobWriteTokenPresent(): boolean {
  return activeWriteTokenPresent(privateMode(), storeTokens());
}

/**
 * Put a MANAGED blob (backups) at a caller-controlled pathname — content-addressed
 * or timestamped, so never a random suffix and never an overwrite. Writes to the
 * ACTIVE store: private when BLOB_PRIVATE is on (fails closed without its token),
 * else public. Mirrors {@link saveFile}'s private/public split for the backup
 * pipeline, which manages its own paths. Reads go back through {@link readFile}.
 */
export async function putManagedBlob(
  pathname: string,
  data: Buffer | string,
  contentType: string,
): Promise<{ url: string; pathname: string }> {
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
  const out: Array<{ pathname: string; url: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000, token });
    for (const b of page.blobs) out.push({ pathname: b.pathname, url: b.url });
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/**
 * List blobs in the ACTIVE store ONLY (private when BLOB_PRIVATE, else public).
 * Use this for existence checks before a new write and for live retention/pruning
 * — those must never cross into the other store, or installing the private token
 * before flipping the flag would already change public-mode behaviour.
 */
export async function listActiveBackupBlobs(prefix: string): Promise<Array<{ pathname: string; url: string }>> {
  const token = activeStoreToken(privateMode(), storeTokens());
  if (!token) return [];
  return collectBlobs(prefix, token);
}

/**
 * List staged uploads in the ACTIVE store, WITH their upload time.
 *
 * Separate from listActiveBackupBlobs because the orphan sweep needs to know how
 * old an object is: deleting one that a phone is still in the middle of
 * registering would destroy a photo somebody just took. collectBlobs drops
 * uploadedAt, and widening it would give every backup caller a field it has no
 * use for.
 */
export type UploadBlob = { pathname: string; url: string; uploadedAt: Date | null };
export type UploadBlobPage = { blobs: UploadBlob[]; cursor: string | null };

/**
 * ONE PAGE at a time, and a cursor to resume from.
 *
 * Deliberately not a "collect everything then act" helper like its backup
 * sibling. The orphan sweep runs on a cron budget, and a version that listed the
 * whole namespace first spent that budget walking the store before deleting
 * anything — so as storage grew it would do less and less real work per tick,
 * and objects past the first page would never be reached at all. Handing back a
 * page and a cursor lets the caller work, check its deadline, and resume.
 */
export async function listActiveUploadBlobPage(
  prefix: string,
  cursor?: string | null,
  limit = 250,
): Promise<UploadBlobPage> {
  const token = activeStoreToken(privateMode(), storeTokens());
  if (!token) return { blobs: [], cursor: null };
  const page = await list({ prefix, cursor: cursor ?? undefined, limit, token });
  return {
    blobs: page.blobs.map((b) => ({ pathname: b.pathname, url: b.url, uploadedAt: b.uploadedAt ?? null })),
    cursor: page.hasMore ? (page.cursor ?? null) : null,
  };
}

/**
 * List blobs across BOTH stores (deduped by pathname). Use this ONLY for
 * restore/verify selection, where a legacy public backup must remain findable
 * after the cutover to the private store.
 */
export async function listAllBackupBlobs(prefix: string): Promise<Array<{ pathname: string; url: string }>> {
  const pub = publicToken() ? await collectBlobs(prefix, publicToken()!) : [];
  const priv = privateToken() ? await collectBlobs(prefix, privateToken()!) : [];
  return dedupeByPathname(pub, priv);
}
