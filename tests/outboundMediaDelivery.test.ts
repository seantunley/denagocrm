import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  attachmentUrlForDelivery,
  canServeOutboundMedia,
  isPubliclyFetchable,
  outboundMediaUrl,
  publicOrigin,
  signOutboundMediaToken,
  verifyOutboundMediaToken,
} from "../src/lib/outboundMedia";
import { classifyDeliveryFailure, PERMANENT_FAILURES } from "../src/lib/messageDelivery";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * META FETCHES THE URL; IT DOES NOT RECEIVE THE BYTES.
 *
 * So the value the outbox queues as an attachment's `url` has to be reachable by
 * a stranger on the public internet. `saveFile` returns three different things
 * and only ONE of them is:
 *
 *   - public blob   → fetchable
 *   - private blob  → 401 without the store token
 *   - self-hosted   → a bare filename, not a URL at all
 *
 * Asserting "the blob exists before we queue it" does not test any of this. The
 * contract is about what the value IS, and these assert that.
 */

const SECRET = "test-secret-value";
const ORIGIN = "https://crm.example.com";

test("only a genuinely public reference is queued unchanged", () => {
  assert.equal(isPubliclyFetchable("https://abc123.public.blob.vercel-storage.com/uploads/x.png"), true);

  // The private store is a different host and needs a token.
  assert.equal(isPubliclyFetchable("https://abc.private.blob.vercel-storage.com/uploads/x.png"), false);
  // A suffix check, so a lookalike host cannot pass by embedding the string.
  assert.equal(isPubliclyFetchable("https://evil.com/.private.blob.vercel-storage.com/x"), true);
  assert.equal(isPubliclyFetchable("https://x.private.blob.vercel-storage.com.evil.com/x"), true);

  // A bare filename — the self-hosted case — is not a URL.
  assert.equal(isPubliclyFetchable("9f3c1a2b-photo.png"), false);
  assert.equal(isPubliclyFetchable("../../etc/passwd"), false);
  // Nor is anything unencrypted; Meta will not fetch it and neither will we sign it.
  assert.equal(isPubliclyFetchable("http://example.com/x.png"), false);
});

test("a public blob URL is passed through untouched", () => {
  const blob = "https://abc123.public.blob.vercel-storage.com/uploads/x.png";
  assert.equal(outboundMediaUrl(blob, "image/png", { secret: SECRET, origin: ORIGIN }), blob);
});

test("a private or local reference becomes a signed URL on our own public origin", () => {
  for (const ref of ["https://abc.private.blob.vercel-storage.com/uploads/x.png", "9f3c1a2b-photo.png"]) {
    const url = outboundMediaUrl(ref, "image/png", { secret: SECRET, origin: ORIGIN });
    assert.ok(url, `${ref} must be rewritten, not queued as-is`);
    assert.ok(url!.startsWith(`${ORIGIN}/api/outbound-media/`), url!);
    // And the thing Meta will fetch never contains the raw storage ref in a
    // form somebody could edit into a different one.
    const token = url!.slice(`${ORIGIN}/api/outbound-media/`.length);
    const claim = verifyOutboundMediaToken(token, SECRET);
    assert.equal(claim?.ref, ref);
    assert.equal(claim?.contentType, "image/png");
  }
});

/**
 * Null is a REFUSAL, not a fallback: the caller must fail the send rather than
 * queue a value that will be retried into a dead letter. A person told "this
 * deployment cannot serve attachments" can act; a message that silently never
 * arrives cannot be acted on at all.
 */
test("a deployment that cannot serve the provider refuses instead of guessing", () => {
  const local = "9f3c1a2b-photo.png";
  assert.equal(outboundMediaUrl(local, "image/png", { secret: SECRET, origin: null }), null);
  // `null`, not `undefined`. Undefined means "read the deployment's own secret",
  // so this assertion used to pass or fail on whether SESSION_SECRET happened to
  // be set in the shell — green here, red in CI, and testing the environment
  // rather than the code either way.
  assert.equal(outboundMediaUrl(local, "image/png", { secret: null, origin: ORIGIN }), null);
  assert.equal(outboundMediaUrl(local, "image/png", { secret: "", origin: ORIGIN }), null);

  // The origins that look configured and are not fetchable by Meta.
  assert.equal(publicOrigin({ NEXT_PUBLIC_APP_URL: "http://localhost:3000" }), null);
  assert.equal(publicOrigin({ NEXT_PUBLIC_APP_URL: "https://localhost:3000" }), null);
  assert.equal(publicOrigin({ NEXT_PUBLIC_APP_URL: "https://dev.local" }), null);
  assert.equal(publicOrigin({ NEXT_PUBLIC_APP_URL: "" }), null);
  assert.equal(publicOrigin({ NEXT_PUBLIC_APP_URL: "https://crm.example.com/" }), ORIGIN);
});

test("omitting an option reads the deployment's own value, and null overrides it", () => {
  // The behaviour the assertion above was accidentally relying on, pinned
  // deliberately instead. Both options must read the same way, because a caller
  // that can express "absent" for one and not the other is how a refusal test
  // comes to depend on the shell it runs in.
  const local = "9f3c1a2b-photo.png";
  const previousSecret = process.env.SESSION_SECRET;
  const previousUrl = process.env.NEXT_PUBLIC_APP_URL;
  try {
    process.env.SESSION_SECRET = "ambient-secret";
    process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
    // Nothing passed: both come from the environment, and the result is usable.
    const url = outboundMediaUrl(local, "image/png");
    assert.ok(url?.startsWith(`${ORIGIN}/api/outbound-media/`), String(url));
    assert.equal(verifyOutboundMediaToken(url!.split("/").pop()!, "ambient-secret")?.ref, local);
    // An explicit null refuses even with the environment fully configured.
    assert.equal(outboundMediaUrl(local, "image/png", { secret: null }), null);
    assert.equal(outboundMediaUrl(local, "image/png", { origin: null }), null);

    // And a deployment with no secret at all refuses, whatever the origin says.
    delete process.env.SESSION_SECRET;
    assert.equal(outboundMediaUrl(local, "image/png"), null);
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = previousUrl;
  }
});

/**
 * The endpoint is anonymous by necessity — Meta presents no credentials — so the
 * URL is the only thing between a stranger and a customer's attachment.
 */
test("the token carries its own authority and expires", () => {
  const future = Date.now() + 60_000;
  const token = signOutboundMediaToken("file.png", "image/png", future, SECRET);
  assert.ok(verifyOutboundMediaToken(token, SECRET));

  // Wrong secret, tampered payload, and expiry are all refused.
  assert.equal(verifyOutboundMediaToken(token, "another-secret"), null);
  const [payload, mac] = token.split(".");
  const swapped = Buffer.from(JSON.stringify({ ref: "../../secret", contentType: "text/html", expiresAt: future }), "utf8").toString("base64url");
  assert.equal(verifyOutboundMediaToken(`${swapped}.${mac}`, SECRET), null, "a re-pointed ref must not verify");
  assert.equal(verifyOutboundMediaToken(signOutboundMediaToken("file.png", "image/png", Date.now() - 1, SECRET), SECRET), null);
  assert.equal(verifyOutboundMediaToken("not-a-token", SECRET), null);
  assert.equal(verifyOutboundMediaToken("", SECRET), null);
});

test("the route serves only what it signed, and never as something executable", () => {
  const route = stripComments(src("src/app/api/outbound-media/[token]/route.ts"));
  assert.match(route, /verifyOutboundMediaToken\(token, secret\)/, "an unsigned ref must never be read");
  assert.match(route, /"Content-Type": claim\.contentType/, "the type comes from the signed claim, not the request");
  assert.match(route, /"X-Content-Type-Options": "nosniff"/);
  assert.match(route, /"Content-Disposition": "attachment"/);
  assert.match(route, /"Cache-Control": "private, no-store"/);
  // One answer for bad signature, tampering and expiry — anything else tells a
  // prober which part to keep trying.
  assert.equal((route.match(/status: 404/g) ?? []).length, 3, "missing secret, bad/expired token and an unreadable ref all answer the same");
  assert.doesNotMatch(route, /status: 40[13]/, "a distinct code would distinguish the failure modes");
});

/**
 * THE DURABILITY PROPERTY, WHICH IS NOT THE SECURITY PROPERTY.
 *
 * The relay URL expires — that is deliberate, and the tests above cover it. But
 * the reply action minted one when the person pressed Send and put it IN the
 * durable outbox payload, which quietly undid the guarantee this whole branch
 * exists to add: after a worker outage, a paused drain, a deployment or a
 * backlog longer than the TTL, the row survived perfectly and the attachment it
 * was trying to deliver had been dead for an hour. It would then retry a URL
 * that could never work until the row dead-lettered.
 *
 * A durable queue cannot store an expiring credential. It stores the identity
 * and mints the credential per attempt.
 */

test("the queue stores the durable reference, never an expiring URL", () => {
  const action = stripComments(src("src/app/actions/messenger.ts"));
  // The payload carries the storage ref and the content type; no URL is minted
  // here at all, only the question of whether one COULD be.
  assert.match(action, /ref: attachmentUrl,/, "the payload keeps the durable storage ref");
  assert.match(action, /canServeOutboundMedia\(attachmentUrl\)/, "accept-time check asks, it does not mint");
  assert.doesNotMatch(action, /outboundMediaUrl\(/, "the action must not mint a URL it would then persist");
  assert.doesNotMatch(action, /url: providerUrl/, "an expiring URL must never enter the payload");
  assert.match(action, /ATTACHMENT_BODY\[attachmentKind\],\s*\n\s*attachmentUrl,/, "history keeps the storage ref");
  // The location is a delivery detail; the digest is the message identity.
  assert.match(action, /attachmentDigest: digest,/);

  // And the worker mints from the ref rather than reading a stored url.
  const outbox = stripComments(src("src/lib/botOutbox.ts"));
  const attachmentBranch = outbox.slice(
    outbox.indexOf('if (message.type === "attachment")'),
    outbox.indexOf('if (row.channel === "whatsapp")'),
  );
  assert.match(attachmentBranch, /const url = attachmentUrlForDelivery\(message\);/);
  assert.match(attachmentBranch, /sendDirectAttachment\(row\.channel, row\.key, \{ type: message\.kind, url \}\)/);
  // A flow's own `image` message carries a URL its author supplied, which is not
  // a minted credential and is not in scope here; the ATTACHMENT branch must have
  // no stored-url route at all.
  assert.doesNotMatch(attachmentBranch, /message\.url/, "the payload's own url is not a delivery route any more");
  // And the payload type no longer has anywhere to put one.
  assert.doesNotMatch(outbox, /type: "attachment";[\s\S]{0,400}\n\s+url: string;/, "the attachment payload has no url field");
});

test("a message queued long before its delivery attempt still gets a usable URL", () => {
  // The regression, in the terms that actually failed: queue private/local media,
  // let far more than the relay TTL pass, then deliver.
  const local = "9f3c1a2b-photo.png";
  const queuedAt = 1_700_000_000_000;
  const deliveredAt = queuedAt + 6 * 60 * 60 * 1000; // six hours of outage

  // What the OLD code did: mint at queue time, store it, send it later.
  const mintedAtQueueTime = outboundMediaUrl(local, "image/jpeg", {
    secret: SECRET,
    origin: ORIGIN,
    now: queuedAt,
  });
  assert.ok(mintedAtQueueTime, "the queue-time URL was valid when it was made");
  assert.equal(
    verifyOutboundMediaToken(mintedAtQueueTime!.split("/").pop()!, SECRET, deliveredAt),
    null,
    "and by delivery time it is dead — which is exactly why it must not be stored",
  );

  // What the queue stores now, and what the worker does with it.
  const payload = { type: "attachment" as const, kind: "image" as const, ref: local, contentType: "image/jpeg" };
  const mintedAtDelivery = attachmentUrlForDelivery(payload, {
    secret: SECRET,
    origin: ORIGIN,
    now: deliveredAt,
  });
  assert.ok(mintedAtDelivery, "the worker must produce a URL at delivery time");
  const claim = verifyOutboundMediaToken(mintedAtDelivery!.split("/").pop()!, SECRET, deliveredAt);
  assert.equal(claim?.ref, local, "and it must point at the same bytes");
  assert.equal(claim?.contentType, "image/jpeg");
  assert.notEqual(mintedAtDelivery, mintedAtQueueTime, "a fresh credential, not the stored one");

  // A second attempt after ANOTHER TTL is fine too — nothing accumulates staleness.
  const retryAt = deliveredAt + 6 * 60 * 60 * 1000;
  const retryUrl = attachmentUrlForDelivery(payload, { secret: SECRET, origin: ORIGIN, now: retryAt });
  assert.ok(verifyOutboundMediaToken(retryUrl!.split("/").pop()!, SECRET, retryAt));
});

test("a deployment that cannot serve media refuses at accept time AND at delivery", () => {
  const local = "9f3c1a2b-photo.png";
  assert.equal(canServeOutboundMedia(local, { secret: SECRET, origin: null }), false);
  assert.equal(canServeOutboundMedia(local, { secret: null, origin: ORIGIN }), false);
  assert.equal(canServeOutboundMedia(local, { secret: SECRET, origin: ORIGIN }), true);
  // A public blob needs no relay at all, so it is always servable.
  assert.equal(canServeOutboundMedia("https://abc.public.blob.vercel-storage.com/x.png", { secret: null, origin: null }), true);

  // And the worker's own refusal, for the case where config changed after accept.
  const payload = { type: "attachment" as const, kind: "file" as const, ref: local };
  assert.equal(attachmentUrlForDelivery(payload, { secret: SECRET, origin: null }), null);

  // That refusal must be retryable, not a dead letter: an operator fixing the
  // origin should see the backlog drain rather than find it discarded.
  const outbox = stripComments(src("src/lib/botOutbox.ts"));
  const refusal = outbox.slice(outbox.indexOf("const url = attachmentUrlForDelivery"));
  const message = refusal.slice(0, refusal.indexOf("sendDirectAttachment"));
  assert.match(message, /Attachments are not configured for delivery/);
  assert.equal(classifyDeliveryFailure("Attachments are not configured for delivery: this deployment has no public https origin Meta could fetch from"), "not_configured");
  assert.equal(PERMANENT_FAILURES.has("not_configured"), false, "a fixable config problem must not dead-letter");
});
