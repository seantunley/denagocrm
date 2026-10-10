import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";

/**
 * The customer's signing page: readable on a phone, a copy to keep before and
 * after signing, a typed signature, and a Sign button that answers at once.
 *
 * Two of these hand a document to someone holding only a link, so most of what
 * is pinned here is who may NOT have it.
 */

// signedCopyPass.ts and securityPolicy.ts are server modules; they are pure apart from that marker.
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: Loader };
const realLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  return realLoad.call(this, request, parent, isMain);
};
process.env.SESSION_SECRET ||= "unit-test-session-secret";

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
/** Code only — a rule that survives solely in a comment is not a rule. */
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SIGN_ROUTE = "src/app/api/signing/[token]/route.ts";
const SIGNED_ROUTE = "src/app/api/signing/[token]/signed/route.ts";
const DOCUMENT_ROUTE = "src/app/api/signing/[token]/document/route.ts";
const SURFACE = "src/app/signing/[token]/SignSurface.tsx";

// ── The pass that lets the signing browser fetch its signed copy ─────────────

test("a signed-copy pass is honoured only for the signer and workspace it names, and only for a while", async () => {
  const { mintSignedCopyPass, verifySignedCopyPass, SIGNED_COPY_PASS_MINUTES } = await import("../src/lib/signing/signedCopyPass");
  const now = Date.UTC(2026, 9, 10, 9, 0, 0);
  const pass = mintSignedCopyPass("rec_1", "tenant_a", now);

  assert.equal(verifySignedCopyPass(pass, "rec_1", "tenant_a", now + 60_000), true);
  assert.equal(verifySignedCopyPass(pass, "rec_2", "tenant_a", now + 60_000), false, "another signer on the same document");
  assert.equal(verifySignedCopyPass(pass, "rec_1", "tenant_b", now + 60_000), false, "the same id in another workspace");
  assert.equal(verifySignedCopyPass(pass, "rec_1", "tenant_a", now + SIGNED_COPY_PASS_MINUTES * 60_000), false, "it lapses on its own");
  assert.ok(SIGNED_COPY_PASS_MINUTES <= 30, "a shared computer must forget quickly");
});

test("a signed-copy pass cannot be forged, edited, or borrowed from the in-person pass", async () => {
  const { mintSignedCopyPass, verifySignedCopyPass } = await import("../src/lib/signing/signedCopyPass");
  const { mintInPersonPass } = await import("../src/lib/signing/inPerson");
  const now = Date.UTC(2026, 9, 10, 9, 0, 0);
  const pass = mintSignedCopyPass("rec_1", "tenant_a", now);
  const [body, mac] = pass.split(".");

  for (const bad of [undefined, "", "nonsense", body, `${body}.`, `${body}.${"0".repeat(mac.length)}`, `${pass}.extra`]) {
    assert.equal(verifySignedCopyPass(bad, "rec_1", "tenant_a", now), false, `refuses ${JSON.stringify(bad)}`);
  }
  // Re-pointed at another signer, keeping the original signature.
  const repointed = Buffer.from(JSON.stringify({ r: "rec_2", t: "tenant_a", e: now + 600_000 }), "utf8").toString("base64url");
  assert.equal(verifySignedCopyPass(`${repointed}.${mac}`, "rec_2", "tenant_a", now), false);
  // A pass a member of staff holds for the same signer is a different thing entirely.
  const staffPass = mintInPersonPass("rec_1", "tenant_a", { userId: "user_1", name: "Staff" }, now);
  assert.equal(verifySignedCopyPass(staffPass, "rec_1", "tenant_a", now), false);
});

test("the pass travels in a cookie the page cannot read, sent to one address only", async () => {
  const { signedCopyCookieOptions, signedCopyPath } = await import("../src/lib/signing/signedCopyPass");
  const token = "a".repeat(56);
  const options = signedCopyCookieOptions(token);
  assert.equal(options.httpOnly, true, "script on the page must not be able to lift it");
  assert.equal(options.sameSite, "strict");
  assert.equal(options.path, signedCopyPath(token));
  assert.equal(options.path, `/api/signing/${token}/signed`, "not sent with any other request, including other documents'");
  assert.ok(options.maxAge <= 30 * 60);
});

test("only the signer's own device is handed the pass — never a member of staff's", () => {
  const route = code(SIGN_ROUTE);
  assert.match(
    route,
    /if \(!witness\) \{\s*\(await cookies\(\)\)\.set\(SIGNED_COPY_COOKIE, mintSignedCopyPass\(recipient\.id, recipient\.tenantId\), signedCopyCookieOptions\(token\)\);\s*\}/,
    "minted for the row's signer and workspace, and not when the signature was witnessed in person",
  );
  const commit = route.indexOf("await prisma.$transaction(");
  assert.ok(route.indexOf("mintSignedCopyPass(") > commit, "only after the signature has been committed");
});

// ── The signed copy ─────────────────────────────────────────────────────────

test("the signed copy is served on the pass, not on the link", () => {
  const route = code(SIGNED_ROUTE);
  const refusal = route.search(/if \(!recipient \|\| !recipient\.tenantId \|\| !verifySignedCopyPass\(pass, recipient\.id, recipient\.tenantId\)\) \{\s*return new Response\("Not available", \{ status: 403 \}\);/);
  assert.ok(refusal > 0, "no pass, a bad pass and no such link are one and the same answer");
  for (const later of ["request.status", "request.signedPdfRef", "openFileStream(", "Response.json("]) {
    assert.ok(route.indexOf(later) > refusal, `${later} is reached before the pass has been checked`);
  }
  assert.match(route, /recipient\.status !== "signed"/, "only for someone who actually signed");
  assert.match(route, /const ready = request\.status === "completed" && Boolean\(request\.signedPdfRef\);/);
  assert.match(route, /if \(!ready\) return new Response\(/, "nothing is streamed until the document is complete");
  assert.doesNotMatch(route, /\.json\(\)|formData\(\)|export async function POST/, "it takes no input and changes nothing");
  assert.match(route, /throttlePublic\("signing-read", token, SIGNING_READ_POLICY\)/);
});

test("asking whether the copy is ready cannot use up the attempts signing needs", async () => {
  const { SIGNING_POLICY, SIGNING_READ_POLICY } = await import("../src/lib/rateLimit");
  assert.ok(SIGNING_READ_POLICY.limit > SIGNING_POLICY.limit);
  for (const route of [SIGNED_ROUTE, DOCUMENT_ROUTE]) {
    assert.doesNotMatch(code(route), /rateLimitSigning\(/, `${route} must count under its own scope`);
  }
  // The page asks a bounded number of times, well inside the read limit.
  const waits = /const waits = \[([^\]]+)\];/.exec(code(SURFACE));
  assert.ok(waits, "the page states how long it keeps asking");
  assert.ok(waits[1].split(",").length + 1 < SIGNING_READ_POLICY.limit / 2);
});

// ── A copy before signing ───────────────────────────────────────────────────

test("the copy before signing goes only to someone the page would show the document to", () => {
  const route = code(DOCUMENT_ROUTE);
  assert.match(route, /resolveSignRecipientTenant\(token\)/, "a revoked link reaches none of it");
  assert.doesNotMatch(route, /resolveSignRecipientTenantForNotice/);

  const stream = route.indexOf("openFileStream(");
  assert.ok(stream > 0);
  const refusals: Array<[RegExp, string]> = [
    [/request\.deletedAt \|\| isRequestClosed\(request\.status\) \|\| \(request\.expiresAt && request\.expiresAt < new Date\(\)\)/, "a finished or expired request"],
    [/assurance\.required && !assurance\.verified/, "a signer who has not passed the identity check"],
    [/recipient\.role === "viewer" \|\| recipient\.status === "signed" \|\| recipient\.status === "declined"/, "a viewer, or a signer who is done"],
    [/request\.ordering === "sequential"/, "a signer whose turn it is not"],
  ];
  for (const [pattern, who] of refusals) {
    const at = route.search(pattern);
    assert.ok(at > 0 && at < stream, `the file is opened before refusing ${who}`);
  }
  assert.match(route, /openFileStream\(request\.unsignedPdfRef, request\.tenantId\)/, "the PDF that was sent, from the request's own workspace");
});

// ── The Sign button answers at once ─────────────────────────────────────────

test("the signer is answered before the document is sealed and sent", () => {
  const route = code(SIGN_ROUTE);
  assert.match(route, /await runAfterResponse\(\(\) => advanceAfterSignature\(request\.id\)\);/);
  assert.doesNotMatch(route, /await advanceAfterSignature\(/, "completion must not sit between the signer and their answer");
  assert.ok(route.indexOf("runAfterResponse(") > route.indexOf("await prisma.$transaction("), "only once the signature is committed");
});

// ── Typed signatures ────────────────────────────────────────────────────────

test("a typed signature is the same kind of image as a drawn one, and says which it was", () => {
  const surface = code(SURFACE);
  assert.match(surface, /onDone\(ref\.current!\.toDataURL\("image\/png"\), "drawn"\)/);
  assert.match(surface, /onDone\(await typedSignaturePng\(text\), "typed"\)/);
  assert.match(surface, /return canvas\.toDataURL\("image\/png"\);/, "a PNG, so the route's checks on signature images apply unchanged");
  assert.match(surface, /await document\.fonts\.load\(/, "never drawn in the fallback face");
  assert.match(surface, /\.\.\.\(isSignatureKind\(f\.kind\) && methods\[f\.id\] && vals\[f\.id\] \? \{ method: methods\[f\.id\] \} : \{\}\)/);

  const route = code(SIGN_ROUTE);
  assert.match(route, /method: z\.enum\(\["drawn", "typed"\]\)\.optional\(\)/, "anything else is refused by the strict schema");
  assert.match(route, /metadata: \{ kind: update\.kind, \.\.\.\(update\.method \? \{ method: update\.method \} : \{\}\) \}/, "recorded in the evidence chain");
  assert.match(route, /\.\.\.\(drawnOrTyped && field\.method \? \{ method: field\.method \} : \{\}\)/, "and only for a signature image");
});

// ── Reading and getting through it on a phone ───────────────────────────────

test("zoom enlarges the sheet and everything placed on it together", () => {
  const surface = code(SURFACE);
  assert.match(surface, /const scale = fit \* zoom;/, "one scale, so fields stay on the lines they were placed on");
  assert.match(surface, /overflowX: zoom > 1 \? "auto" : "visible"/, "a zoomed page scrolls sideways instead of being cut off");
  assert.match(surface, /const ZOOMS = \[1, /, "it starts fitted to the screen");
});

test("Next walks the required fields in reading order, then goes to the Sign button", () => {
  const surface = code(SURFACE);
  assert.match(surface, /\.sort\(\(a, b\) => a\.page - b\.page \|\| a\.y - b\.y \|\| a\.x - b\.x\)\s*\.concat\(unplaced\)\s*\.filter\(\(f\) => f\.required && f\.kind !== "date" && !isFilled\(f\)\)/);
  assert.match(surface, /if \(!next\) \{\s*actionRef\.current\?\.scrollIntoView/);
  assert.match(surface, /if \(isSignatureKind\(next\.kind\)\) window\.setTimeout\(\(\) => setSigningId\(next\.id\), \d+\);/, "a signature box opens the pad");
  assert.match(surface, /\{todo\.length > 0 \? "Next →" : "Go to sign →"\}/);
});

// ── "I have a question" ─────────────────────────────────────────────────────

const QUESTION_ROUTE = "src/app/api/signing/[token]/question/route.ts";

test("a question is accepted only from someone who could sign", () => {
  const route = code(QUESTION_ROUTE);
  assert.match(route, /resolveSignRecipientTenant\(token\)/, "a revoked link cannot ask");
  assert.doesNotMatch(route, /resolveSignRecipientTenantForNotice/);

  const recorded = route.indexOf("await logSignEvent(");
  assert.ok(recorded > 0);
  const refusals: Array<[RegExp, string]> = [
    [/request\.deletedAt \|\| isRequestClosed\(request\.status\) \|\| \(request\.expiresAt && request\.expiresAt < new Date\(\)\)/, "a finished or expired request"],
    [/assurance\.required && !assurance\.verified/, "a signer who has not passed the identity check — it is filed under their name"],
    [/recipient\.role === "viewer" \|\| recipient\.status === "signed" \|\| recipient\.status === "declined"/, "a viewer, or a signer who is done"],
    [/request\.ordering === "sequential"/, "a signer whose turn it is not"],
    [/earlier\.length >= MAX_QUESTIONS/, "a signer who has already sent several"],
    [/Date\.now\(\) - earlier\[0\]\.createdAt\.getTime\(\) < COOLDOWN_MS/, "a second question seconds after the first"],
  ];
  for (const [pattern, who] of refusals) {
    const at = route.search(pattern);
    assert.ok(at > 0 && at < recorded, `the question is recorded before refusing ${who}`);
  }
  assert.match(route, /z\.object\(\{ question: z\.string\(\)\.trim\(\)\.min\(3\)\.max\(1000\) \}\)\.strict\(\)/, "bounded, and nothing else is read from the request");
  assert.match(route, /throttlePublic\("signing-question", token, PUBLIC_ACTION_POLICY\)/, "its own scope — asking cannot use up signing's attempts");
  assert.doesNotMatch(route, /\.update\(|\.updateMany\(|\.upsert\(|\.delete\(|\.deleteMany\(/, "asking signs nothing, declines nothing, and leaves the request as it was");
});

test("a question is contact from the customer — on the timeline, by push, and by an email the sender can reply to", () => {
  const delivery = code("src/lib/signing/question.ts");
  assert.match(delivery, /type: QUESTION_COMMUNICATION_TYPE,\s*direction: "inbound",/);
  assert.match(delivery, /contactId: subject\.contactId,\s*leadId: subject\.leadId,/, "on the customer AND the deal");
  assert.match(delivery, /tenantId: await customerRecordTenantId\(\{ contactId: subject\.contactId, leadId: subject\.leadId \}\)/);
  assert.match(delivery, /"quote_feedback",\s*\{ tenantId: request\.tenantId \}/, "a switchable alert, kept inside the workspace");
  assert.match(delivery, /signer\.email && isReplyToAddress\(signer\.email\.trim\(\)\)/, "the Reply-To is validated as a header value");
  assert.match(delivery, /return timeline \|\| email;/, "the signer is only told it was sent when it reached somebody");
  assert.doesNotMatch(delivery, /sendSms|sendWhatsApp|to: signer\.email/, "nothing here contacts the customer");
});

test("a question that arrives is not a note: the deal must read as waiting on a reply", async () => {
  const { INTERNAL_COMMUNICATION_TYPES } = await import("../src/lib/customerContact");
  // question.ts pulls in the database client, so the constant is read from its source.
  const type = /QUESTION_COMMUNICATION_TYPE = "([a-z]+)"/.exec(src("src/lib/signing/question.ts"))?.[1];
  assert.ok(type, "the timeline type is declared");
  assert.ok(!(INTERNAL_COMMUNICATION_TYPES as readonly string[]).includes(type), "internal types never count as the customer getting in touch");
});

test("a member of staff's device is offered neither download nor the question", () => {
  const surface = code(SURFACE);
  assert.match(surface, /\{!inPerson && \(\s*<a href=\{`\/api\/signing\/\$\{token\}\/document`\}/);
  assert.match(surface, /\{inPerson \? null : <SignedCopy token=\{token\} \/>\}/);
  assert.equal((surface.match(/\{!inPerson && questionDialog\(<button/g) ?? []).length, 2, "beside Sign, and in the bar that follows the page");
});
