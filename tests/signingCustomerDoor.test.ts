import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import Module from "node:module";
import { hashSignToken, newSignToken } from "../src/lib/signing/tokens";
import { SIGNING_CONSENT, consentFor } from "../src/lib/signing/consent";
import { finishedNotice, type FinishedNoticeInput } from "../src/lib/signing/finishedNotice";

/**
 * The customer's door into signing: the in-person screen, the portal button, and
 * what a link says once its document is finished.
 *
 * All three were broken the same quiet way (review of 2026-10-09). The recipient
 * row stores a DIGEST of the signing link; two screens handed that digest out as
 * though it were the link, and the page a customer lands on after signing
 * answered "not found" for a link that had simply done its job.
 */

// inPerson.ts and securityPolicy.ts are server modules; they are pure apart from that marker.
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

const IN_PERSON_PAGE = "src/app/(handover)/signatures/[id]/sign/[recipientId]/page.tsx";

// ── The in-person pass ──────────────────────────────────────────────────────

test("an in-person pass is honoured only for the signer and workspace it names, and only for a while", async () => {
  const { mintInPersonPass, verifyInPersonPass, IN_PERSON_PASS_MINUTES } = await import("../src/lib/signing/inPerson");
  const now = Date.UTC(2026, 9, 9, 10, 0, 0);
  const witness = { userId: "user_staff", name: "Thandi Mokoena" };
  const pass = mintInPersonPass("rec_1", "tenant_a", witness, now);

  assert.deepEqual(verifyInPersonPass(pass, "rec_1", "tenant_a", now + 60_000), witness);
  assert.equal(verifyInPersonPass(pass, "rec_2", "tenant_a", now), null, "another signer on the same request");
  assert.equal(verifyInPersonPass(pass, "rec_1", "tenant_b", now), null, "the same id in another workspace");
  assert.equal(verifyInPersonPass(pass, "rec_1", "tenant_a", now + IN_PERSON_PASS_MINUTES * 60_000), null, "expired");
  assert.ok(IN_PERSON_PASS_MINUTES <= 60, "a pass that outlives the visit is a standing way round the code");
});

test("an in-person pass cannot be forged, edited or re-pointed", async () => {
  const { mintInPersonPass, verifyInPersonPass } = await import("../src/lib/signing/inPerson");
  const now = Date.UTC(2026, 9, 9, 10, 0, 0);
  const pass = mintInPersonPass("rec_1", "tenant_a", { userId: "user_staff", name: "Thandi" }, now);
  const [body, mac] = pass.split(".");

  // Re-point the body at another signer and keep the genuine MAC.
  const forged = Buffer.from(JSON.stringify({ r: "rec_2", t: "tenant_a", u: "user_staff", n: "Thandi", e: now + 3_600_000 })).toString("base64url");
  assert.equal(verifyInPersonPass(`${forged}.${mac}`, "rec_2", "tenant_a", now), null);
  // Extend the expiry.
  const extended = Buffer.from(JSON.stringify({ r: "rec_1", t: "tenant_a", u: "user_staff", n: "Thandi", e: now + 10 * 365 * 86_400_000 })).toString("base64url");
  assert.equal(verifyInPersonPass(`${extended}.${mac}`, "rec_1", "tenant_a", now), null);
  // A MAC of the right shape that is not ours, and things that are not passes at all.
  assert.equal(verifyInPersonPass(`${body}.${"0".repeat(64)}`, "rec_1", "tenant_a", now), null);
  for (const junk of ["", "x", ".", `${body}.`, `.${mac}`, `${body}.${mac}.extra`, "not base64.deadbeef"]) {
    assert.equal(verifyInPersonPass(junk, "rec_1", "tenant_a", now), null, `"${junk.slice(0, 20)}" must not verify`);
  }
});

test("a pass is not interchangeable with any other value made under the same secret", async () => {
  const { signingHmac, signingOtpHash } = await import("../src/lib/signing/securityPolicy");
  assert.notEqual(signingHmac("in-person-signing:v1", "abc"), signingHmac("something-else", "abc"), "each purpose has its own key");
  // The one-time-code hash signs `tenant:recipient:code` with the same secret. A
  // purpose that was only a PREFIX on the message is that same computation
  // whenever the strings line up — which is exactly what this caught.
  assert.notEqual(signingHmac("in-person-signing:v1", "abc"), signingOtpHash("in-person-signing", "v1", "abc"));
  assert.notEqual(signingHmac("a", "b:c"), signingOtpHash("a", "b", "c"));
});

// ── What the in-person screen hands over ────────────────────────────────────

test("the in-person screen submits to the real link, never the stored digest", () => {
  const page = code(IN_PERSON_PAGE);
  assert.match(page, /usableCapability\("signatureRecipient", recipient\.id, recipient\.tokenCiphertext, recipient\.token\)/);
  assert.match(page, /token=\{link\}/, "the surface gets what usableCapability returned");
  assert.doesNotMatch(page, /token=\{recipient\.token\}/, "the digest column is not a link");

  // Why that matters, executed: the route hashes what arrives before it looks it up.
  const raw = newSignToken();
  const stored = hashSignToken(raw);
  assert.equal(hashSignToken(raw), stored, "the real link resolves to its row");
  assert.notEqual(hashSignToken(stored), stored, "the digest, posted back, resolves to nothing");
});

test("the in-person screen is outside the CRM shell and checks the record, not just the permission", () => {
  assert.ok(!existsSync(new URL("../src/app/(app)/signatures/[id]/sign/[recipientId]/page.tsx", import.meta.url)), "the copy inside the app shell must be gone — two pages cannot own one URL");
  const page = code(IN_PERSON_PAGE);
  assert.match(page, /requirePermission\("signing\.manage"\)/);
  assert.match(page, /canAccessSignatureRequest\(user, req\)/, "signing.manage is not access to this record");
  assert.doesNotMatch(page, /AppShell|IdentityGate/, "no CRM chrome, and no emailed code with staff standing there");
  assert.match(page, /mintInPersonPass\(recipient\.id, recipient\.tenantId, \{ userId: user\.id, name: user\.name \}\)/);
  // Whose turn it is still applies: a pass is not a way round an approval.
  assert.match(page, /req\.workflowGraphJson && req\.currentNodeId !== recipient\.nodeId/);
  const layout = code("src/app/(handover)/layout.tsx");
  assert.match(layout, /assertPathModuleEnabled\(\)/);
  assert.doesNotMatch(layout, /AppShell/);
});

for (const [route, what] of [
  ["src/app/api/signing/[token]/route.ts", "signing"],
  ["src/app/api/signing/[token]/decline/route.ts", "declining"],
] as const) {
  test(`the ${what} route accepts a witness in place of the code — at both gates, and never an invalid one`, () => {
    const body = code(route);
    assert.match(body, /verifyInPersonPass\((?:submission|parsed\.data)\.inPerson, recipient\.id, (?:recipient\.)?tenantId\)/, "verified against the ROW's signer and workspace");
    assert.match(body, /if \((?:submission|parsed\.data)\.inPerson && !witness\) \{\s*return new Response\([^)]*\{ status: 403 \}\)/, "a pass that does not verify is refused, not ignored");
    assert.match(body, /assurance\.required && !assurance\.verified && !witness/, "the check before the transaction");
    assert.match(body, /identityMode !== "link" && !locked(?:Recipient|\[0\])\.identityVerifiedAt && !witness/, "…and the one under the row lock");
    assert.match(body, /resolveSignRecipientTenant\(token\)/, "a revoked link still cannot act");
    assert.doesNotMatch(body, /resolveSignRecipientTenantForNotice/);
  });
}

test("a witnessed signature records who watched and what was agreed to, inside the evidence chain", () => {
  const route = code("src/app/api/signing/[token]/route.ts");
  assert.match(route, /identityMethod: "in_person"/);
  assert.match(route, /witness && !lockedRecipient\.identityVerifiedAt/, "a code already verified keeps its own record");
  const signed = route.slice(route.indexOf('type: "signed"'));
  assert.match(signed.slice(0, 700), /consent,/, "the consent wording goes into the signed event");
  assert.match(signed.slice(0, 700), /witness: \{ userId: witness\.userId, name: witness\.name \}/);

  const certificate = code("src/lib/signing/complete.ts");
  assert.match(certificate, /row\.identityMethod === "in_person"/);
  assert.match(certificate, /where: \{ requestId, type: "signed" \}/, "read back from the events, not from anything editable");
});

// ── Consent ─────────────────────────────────────────────────────────────────

test("the consent a signer ticked is the consent that gets recorded", () => {
  assert.deepEqual(consentFor(SIGNING_CONSENT.version), SIGNING_CONSENT);
  assert.deepEqual(consentFor(undefined), consentFor("za-ecta-v1"), "a page opened before versions were sent showed v1");
  assert.equal(consentFor("made-up"), null, "never record wording the signer may not have seen");
  assert.match(SIGNING_CONSENT.text, /Electronic Communications and Transactions Act 25 of 2002/);

  const surface = code("src/app/signing/[token]/SignSurface.tsx");
  assert.match(surface, /<span>\{SIGNING_CONSENT\.text\}<\/span>/, "the page shows the recorded wording, not a copy of it");
  assert.match(surface, /consentVersion: SIGNING_CONSENT\.version/);
  const route = code("src/app/api/signing/[token]/route.ts");
  assert.match(route, /const consent = consentFor\(submission\.consentVersion\);\s*if \(!consent\) return new Response\(/);
});

// ── The portal ──────────────────────────────────────────────────────────────

test("the portal's Review & sign button carries a link that resolves", () => {
  const page = code("src/app/portal/page.tsx");
  const recipients = page.slice(page.indexOf("recipients: {"), page.indexOf("const unsignedQuotes"));
  assert.match(recipients, /select: \{ tokenCiphertext: true, email: true \}/);
  assert.doesNotMatch(recipients, /recipient\.token\b|token: true/, "the digest column must not reach a URL");
  assert.match(recipients, /revealSignCapability\(recipient\.tokenCiphertext\)/);
  assert.doesNotMatch(page, /usableCapability/, "viewing the portal must never rotate the link in the customer's inbox");
});

// ── A finished link ─────────────────────────────────────────────────────────

const base: FinishedNoticeInput = {
  status: "completed",
  recipient: { status: "signed", signedOn: "30 Sept 2026, 17:50", declinedOn: null },
  completedOn: "30 Sept 2026",
  lastValidDay: null,
  emailHint: "jo••@example.com",
  copySent: true,
  signedCopiesOn: true,
  sender: "Acme Carts",
};

test("a finished link says what happened to the document", () => {
  const signed = finishedNotice(base);
  assert.equal(signed.title, "Signed ✓");
  assert.match(signed.body, /You signed this document on 30 Sept 2026, 17:50\. We emailed the signed copy to jo••@example\.com\./);
  assert.equal(signed.canResendCopy, true);

  assert.match(finishedNotice({ ...base, copySent: false }).body, /is being emailed to/);
  assert.match(finishedNotice({ ...base, recipient: { status: "viewed", signedOn: null, declinedOn: null } }).body, /^This document was completed on 30 Sept 2026\./);

  const declinedByMe = finishedNotice({ ...base, status: "declined", recipient: { status: "declined", signedOn: null, declinedOn: "1 Oct 2026, 09:00" } });
  assert.match(declinedByMe.body, /You declined this document on 1 Oct 2026, 09:00\..*contact Acme Carts/);
  const declinedByOther = finishedNotice({ ...base, status: "declined", recipient: { status: "viewed", signedOn: null, declinedOn: null } });
  assert.doesNotMatch(declinedByOther.body, /You declined/, "another signer's decision is not this person's");

  assert.match(finishedNotice({ ...base, status: "voided" }).body, /^Acme Carts withdrew this document/);
  assert.match(finishedNotice({ ...base, status: "expired", lastValidDay: "6 Oct 2026" }).body, /has expired — it was valid until 6 Oct 2026\. Ask Acme Carts/);
  assert.equal(finishedNotice({ ...base, status: "expired" }).body, "This signing link has expired. Ask Acme Carts to send an updated document.");
  // The page hands over the last day the link WORKED: a link ends at midnight,
  // which is already the next day, and "expired on the 24th" contradicts a quote
  // that says "valid until the 23rd".
  assert.match(code("src/app/signing/[token]/page.tsx"), /lastValidDay: req\.expiresAt \? formatDate\(new Date\(req\.expiresAt\.getTime\(\) - 1\), regional\) : null,/);
  assert.equal(finishedNotice({ ...base, status: "rejected" }).title, "Document unavailable");
  assert.equal(finishedNotice({ ...base, status: "deleted" }).title, "Document unavailable");
});

test("the signed copy is only offered where it can be sent, and only for a completed document", () => {
  assert.equal(finishedNotice({ ...base, emailHint: null }).canResendCopy, false, "no address on file");
  assert.match(finishedNotice({ ...base, emailHint: null }).body, /Ask Acme Carts for your signed copy\./);
  assert.equal(finishedNotice({ ...base, signedCopiesOn: false }).canResendCopy, false, "the workspace has switched signed copies off");
  for (const status of ["declined", "voided", "expired", "rejected", "deleted"]) {
    assert.equal(finishedNotice({ ...base, status }).canResendCopy, false, status);
  }
});

test("an unbranded finished link names nobody", () => {
  for (const status of ["completed", "declined", "voided", "expired", "rejected", "deleted"]) {
    for (const recipientStatus of ["signed", "declined", "viewed"]) {
      const notice = finishedNotice({ ...base, status, sender: null, emailHint: null, recipient: { status: recipientStatus, signedOn: null, declinedOn: null } });
      assert.doesNotMatch(`${notice.title} ${notice.body}`, /Denago|undefined|null/, `${status}/${recipientStatus}`);
    }
  }
  assert.match(finishedNotice({ ...base, status: "voided", sender: null }).body, /^The sender withdrew/);
});

test("the signing page answers a finished link with a message — before anything that could show the document", () => {
  const page = code("src/app/signing/[token]/page.tsx");
  assert.match(page, /resolveSignRecipientTenantForNotice\(token\)/, "a revoked link must reach the page to be told anything");
  const closedAt = page.indexOf("isRequestClosed(req.status) || recipient.tokenRevokedAt");
  assert.notEqual(closedAt, -1);
  for (const later of ["loadRecipientIdentity(token)", "recordView(", "renderRequestSigningSheets(req)", "<SignSurface"]) {
    const at = page.indexOf(later);
    assert.ok(at > closedAt, `${later} must come after the finished-link answer`);
  }
  const notice = page.slice(closedAt, page.indexOf("loadRecipientIdentity(token)"));
  assert.match(notice, /return \(\s*<SigningMessage/, "that branch returns; it never falls through to the document");
  assert.doesNotMatch(notice, /SignSurface|renderRequestSigningSheets|recordView/);

  // And the resolver that lets a revoked link in is used for nothing that acts.
  const resolver = code("src/lib/tokenTenant.ts");
  const strict = resolver.slice(resolver.indexOf("export async function resolveSignRecipientTenant("), resolver.indexOf("export async function resolveSignRecipientTenantForNotice"));
  assert.match(strict, /if \(!row \|\| row\.tokenRevokedAt\) return null;/, "the acting resolver still fails closed");
});

test("sending the signed copy again takes no input and reaches only the address on file", () => {
  const route = code("src/app/api/signing/[token]/copy/route.ts");
  assert.match(route, /export async function POST\(_req: Request/, "the request body is never read");
  assert.doesNotMatch(route, /\.json\(\)|formData\(\)|searchParams/);
  assert.match(route, /request\.status !== "completed" \|\| !request\.signedPdfRef/);
  assert.match(route, /automationOn\("SIGNING_SIGNED_COPIES", recipient\.tenantId\)/, "off means the workspace is not emailing signed copies");
  assert.match(route, /email: recipient\.email, completedEmailSentAt: null/);
  assert.match(route, /rateLimitSigning\(token\)/);
  assert.match(route, /earlier\.length >= MAX_REQUESTS/);
  assert.doesNotMatch(route, /new Response\(pdf|Response\.json\(\{[^}]*pdf/, "the document itself never comes back in the response");
});
