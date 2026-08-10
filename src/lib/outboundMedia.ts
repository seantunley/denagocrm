import crypto from "crypto";

/**
 * A URL THE PROVIDER CAN ACTUALLY FETCH.
 *
 * Meta does not accept bytes on the send endpoint; it accepts a URL and fetches
 * it itself, anonymously, from its own infrastructure. So whatever the outbox
 * stores as an attachment's `url` has to be reachable by a stranger on the
 * public internet — and `saveFile` returns three different things, two of which
 * are not:
 *
 *   - PUBLIC BLOB (`BLOB_READ_WRITE_TOKEN`): an unguessable but publicly
 *     readable `*.blob.vercel-storage.com` URL. Fetchable. Fine as-is.
 *   - PRIVATE BLOB (`BLOB_PRIVATE=true`): a `*.private.blob.vercel-storage.com`
 *     URL that requires the store token. Meta gets a 401.
 *   - SELF-HOSTED / LOCAL: a BARE FILENAME like `9f3c…-photo.png`. Not a URL at
 *     all. Meta gets nothing.
 *
 * Queueing the raw ref in the latter two modes produces a message that is
 * accepted by the CRM, shown in the timeline, retried by the worker and never
 * delivered — the exact class of silent failure the durable queue exists to
 * remove.
 *
 * So a ref that is not already public is rewritten to a signed, expiring URL on
 * this app's own public origin, which `/api/outbound-media/[token]` serves.
 *
 * WHY A SIGNED TOKEN RATHER THAN AN ID. The endpoint is anonymous by necessity —
 * Meta presents no credentials — so the URL is the only thing standing between a
 * stranger and a customer's attachment. It therefore carries its own authority:
 * an HMAC over the storage ref, the content type and an expiry, verified without
 * a database lookup and useless once expired. An opaque row id would be a
 * permanent, guessable-by-enumeration handle to the same bytes.
 */

const DEFAULT_TTL_MS = 60 * 60 * 1000; // Meta fetches within seconds; an hour is slack, not a window.

/** A public blob is already fetchable; a private one is not. */
export function isPubliclyFetchable(ref: string): boolean {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return false; // a bare filename is not a URL
  }
  if (url.protocol !== "https:") return false;
  // The private store is a DIFFERENT host, and it is a suffix check rather than
  // an `includes` so a lookalike host cannot pass by embedding the string.
  if (url.hostname.endsWith(".private.blob.vercel-storage.com")) return false;
  return true;
}

/** The app's own public origin, or null when it is not one the provider can reach. */
export function publicOrigin(env: { NEXT_PUBLIC_APP_URL?: string | undefined } = process.env as { NEXT_PUBLIC_APP_URL?: string }): string | null {
  const raw = (env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // localhost is the common self-hosted/dev case and the one that would
  // otherwise produce a URL that looks right and can never be fetched.
  if (url.protocol !== "https:") return null;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".local")) return null;
  return url.origin;
}

export function signOutboundMediaToken(
  ref: string,
  contentType: string,
  expiresAt: number,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify({ ref, contentType, expiresAt }), "utf8").toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(`outbound-media:${payload}`).digest("base64url");
  return `${payload}.${mac}`;
}

export type OutboundMediaClaim = { ref: string; contentType: string; expiresAt: number };

/** Verify and decode, in constant time for the signature. Null on anything wrong. */
export function verifyOutboundMediaToken(
  token: string,
  secret: string,
  now = Date.now(),
): OutboundMediaClaim | null {
  const split = token.lastIndexOf(".");
  if (split <= 0) return null;
  const payload = token.slice(0, split);
  const mac = token.slice(split + 1);
  const expected = crypto.createHmac("sha256", secret).update(`outbound-media:${payload}`).digest("base64url");
  const given = Buffer.from(mac);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

  let claim: OutboundMediaClaim;
  try {
    claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claim?.ref !== "string" || typeof claim?.contentType !== "string") return null;
  if (typeof claim?.expiresAt !== "number" || claim.expiresAt <= now) return null;
  return claim;
}

/**
 * The URL to queue for this attachment, or null when this deployment cannot
 * produce one the provider could fetch.
 *
 * Null is a REFUSAL, not a fallback. The caller must fail the send rather than
 * queue a ref that will be retried into a dead letter — a person told "not sent,
 * this deployment cannot serve attachments to Meta" can act; a message that
 * silently never arrives cannot be acted on at all.
 */
export function outboundMediaUrl(
  ref: string,
  contentType: string,
  /**
   * `secret` and `origin` behave identically on purpose: OMITTED means "read the
   * deployment's own", and an explicit `null` means "this deployment has none".
   *
   * They were not symmetric — `secret` was `string | undefined`, so the only way
   * to say "no secret" was `undefined`, which is also how you say "use the
   * ambient one". A test written to check the refusal therefore passed or failed
   * on whether SESSION_SECRET happened to be set in the shell, which is how it
   * came to be green locally and red in CI. An option that cannot express the
   * case it is being asked about is a defect in the option.
   */
  options: { secret?: string | null; origin?: string | null; now?: number; ttlMs?: number } = {},
): string | null {
  if (isPubliclyFetchable(ref)) return ref;

  const secret = options.secret === undefined ? process.env.SESSION_SECRET : options.secret;
  const origin = options.origin === undefined ? publicOrigin() : options.origin;
  if (!secret || !origin) return null;

  const expiresAt = (options.now ?? Date.now()) + (options.ttlMs ?? DEFAULT_TTL_MS);
  return `${origin}/api/outbound-media/${signOutboundMediaToken(ref, contentType, expiresAt, secret)}`;
}
