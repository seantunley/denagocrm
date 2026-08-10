import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  isPubliclyFetchable,
  outboundMediaUrl,
  publicOrigin,
  signOutboundMediaToken,
  verifyOutboundMediaToken,
} from "../src/lib/outboundMedia";

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

test("the DM reply refuses rather than queueing a URL the provider cannot fetch", () => {
  const action = stripComments(src("src/app/actions/messenger.ts"));
  assert.match(action, /providerUrl = outboundMediaUrl\(attachmentUrl, contentType\)/);
  assert.match(action, /if \(!providerUrl\) \{[\s\S]{0,200}return \{/, "a deployment that cannot deliver must fail the send");

  // The QUEUED payload carries the provider URL; the timeline row keeps the
  // storage ref, which the inbox renders through its own authenticated route.
  assert.match(action, /\{ type: "attachment", kind: attachmentKind, url: providerUrl, digest: fileDigest \}/);
  assert.match(action, /ATTACHMENT_BODY\[attachmentKind\],\s*\n\s*attachmentUrl,/, "history keeps the storage ref");
  // The provider URL is a delivery detail; the digest is the message identity.
  assert.match(action, /attachmentDigest: digest,/);
});
