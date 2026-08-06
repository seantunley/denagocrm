import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { timestampCoversDigest, timestampAuthorityUrl, timestampingEnabled } from "../src/lib/signing/timestamp";
import {
  resolveIdentityMode,
  parseOtpPolicy,
  parseOtpMinValue,
  DEFAULT_OTP_POLICY,
} from "../src/lib/signing/identityPolicy";

const read = (p: string) => readFileSync(path.join(__dirname, "..", p), "utf8");

// ── Independent proof of when ───────────────────────────────────────────────

test("coverage is read out of the token, not searched for in its bytes", () => {
  const digest = crypto.createHash("sha256").update("a document").digest();

  // THE OLD CHECK, and why it was worthless: a blob that merely CONTAINS the
  // digest bytes is not a timestamp for that document. The previous
  // implementation searched the DER and would have accepted this — the earlier
  // version of this very test asserted that it did, which is how a meaningless
  // check acquired a passing test.
  const notAToken = Buffer.concat([Buffer.from("prefix"), digest, Buffer.from("suffix")]).toString("base64");
  assert.equal(timestampCoversDigest(notAToken, digest), false, "arbitrary bytes containing the digest are not a token");

  assert.equal(timestampCoversDigest("not base64 !!", digest), false);
  assert.equal(timestampCoversDigest("", digest), false);
});

test("a token is fully validated before it is ever stored", () => {
  const source = read("src/lib/signing/timestamp.ts");
  const verify = read("src/lib/signing/timestampVerify.ts");

  // Imprint and nonce only establish that the reply answers THIS request. Over
  // plain HTTP an active attacker can supply a well-formed response carrying
  // both, so nothing is filed until the CMS signature, the timestamping EKU and
  // the chain to a trusted root have all been checked. A stored token that
  // cannot be verified is worse than none: it looks like evidence.
  assert.match(source, /verifyTimestampToken\(parsed\.token\.toString\("base64"\), digest\)/);
  assert.match(source, /if \(!verification\.ok\) return null;/);

  // The signature is verified against the reconstructed SignedAttrs SET…
  assert.match(verify, /createVerify\("RSA-SHA256"\)/);
  assert.match(verify, /Type\.SET, true, children\(signedAttrs\)/);
  // …the signer must be authorised to attest to time…
  assert.match(verify, /not authorised for timestamping/);
  // …and every link in the chain is a signature check, terminating at a root.
  assert.match(verify, /checkIssued\(chain\[i \+ 1\]\) \|\| !chain\[i\]\.verify/);
  assert.match(verify, /chain does not terminate at a trusted root/);

  // forge cannot read these certificates ("unsupported critical extension") and
  // cannot open the token at all ("Only wrapped ContentType Data"). Verifying
  // with a library that rejects valid input would reject every genuine token —
  // the exact failure this file was rewritten to avoid.
  assert.match(verify, /crypto\.X509Certificate/);
  assert.doesNotMatch(verify, /forge\.pki\.verifyCertificateChain/);
});

test("the request and the parse agree on what was asked and answered", () => {
  const source = read("src/lib/signing/timestamp.ts");
  // The imprint is READ from the TSTInfo and compared, and the nonce we sent
  // must come back — that is what stops a token for another document, or a
  // response captured from an earlier exchange, being accepted.
  assert.match(source, /parsed\.imprint\.equals\(digest\)/);
  assert.match(source, /parsed\.nonce\.equals\(nonce\)/);
  assert.match(source, /function readTstInfo/);

  // The boundary moved: chain validation now exists, so the file must no longer
  // describe itself as lacking it.
  assert.doesNotMatch(source, /does not validate the CMS signature/);
});

test("transport is HTTP on purpose, and the reason is recorded", () => {
  const source = read("src/lib/signing/timestamp.ts");
  // Requiring HTTPS looks like hardening and is the opposite: public authorities
  // serve RFC 3161 over HTTP, the token is signed anyway, and this path fails
  // soft — so the requirement silently disables timestamping for every document
  // with no error. I made that change and only a live call caught it.
  assert.match(source, /const DEFAULT_TSA = "http:\/\/timestamp\.digicert\.com"/);
  assert.doesNotMatch(source, /if \(!url\.startsWith\("https:\/\/"\)\) return null;/);
});

test("the timestamp parser descends into the encapsulated TSTInfo", () => {
  // THE BUG A LIVE PROBE CAUGHT. The attested time lives inside an OCTET STRING
  // carrying a nested DER structure, which a parser has no reason to descend
  // into on its own. Without this step the code returned null against a
  // perfectly good response from a real authority — and because timestamping
  // fails soft, it reported "no timestamp" rather than an error anyone would
  // see. Every document would have completed unstamped, silently, forever.
  const source = read("src/lib/signing/timestamp.ts");
  assert.match(source, /Type\.OCTETSTRING/, "the walker must handle an encapsulated structure");
  assert.match(source, /asn1\.fromDer\(forge\.util\.createBuffer\(node\.value\)/);
});

test("timestamping never becomes a precondition of signing", () => {
  const source = read("src/lib/signing/timestamp.ts");
  // A timestamp is evidence ABOUT a signature, not part of one. An authority we
  // do not control must never be able to cost a signed contract.
  assert.match(source, /return null/, "failures resolve to null");
  assert.doesNotMatch(source, /throw new Error/, "nothing here may throw into the completion path");

  const complete = read("src/lib/signing/complete.ts");
  // Requested BEFORE the transaction, so a slow authority cannot hold one open,
  // and stored as plain nullable columns.
  const stampAt = complete.indexOf("requestTrustedTimestamp(");
  const txAt = complete.indexOf("await prisma.$transaction(");
  assert.ok(stampAt !== -1 && txAt !== -1);
  assert.ok(stampAt < txAt, "the timestamp must be obtained outside the completion transaction");
  assert.match(complete, /timestampToken: stamp\?\.tokenBase64 \?\? null/);
});

test("only a hash ever leaves the system", () => {
  const source = read("src/lib/signing/timestamp.ts");
  // This is customer contract data. The authority must learn that something was
  // stamped and nothing else — not the document, the signer or the amount.
  assert.match(source, /digest\.length !== 32/, "only a SHA-256 digest is accepted");
  assert.match(source, /body: new Uint8Array\(buildRequest\(digest, nonce\)\)/);
  // The nonce is what stops a captured response being replayed as a fresh one.
  assert.match(source, /crypto\.randomBytes\(16\)/);
  // A token whose time is wildly out is unusable as evidence and is refused.
  assert.match(source, /skewMs > 24 \* 60 \* 60 \* 1000/);
});

test("the certificate makes no timestamp claim at all", () => {
  const complete = read("src/lib/signing/complete.ts");
  // It used to describe submitting the hash to "an independent RFC 3161
  // timestamp authority" and storing the attestation. Nothing verifies the
  // response signature, so the system cannot establish that any authority
  // issued it — and a customer-facing document is the last place to assert
  // something that cannot be backed. The claim comes back when the validation
  // does, not before.
  assert.doesNotMatch(complete, /RFC 3161/);
  assert.doesNotMatch(complete, /timestamp authority/);
  assert.match(complete, /times recorded above are this system/);
});

// ── When a signer must prove who they are ───────────────────────────────────

const money = (amount: number | null) => ({ amount });

test("money attached asks for a code; routine paperwork does not", () => {
  assert.equal(DEFAULT_OTP_POLICY, "money", "the shipped default");

  const base = { policy: "money" as const, minValue: 0 };
  assert.equal(resolveIdentityMode({ ...base, value: money(15000) }), "otp");
  assert.equal(resolveIdentityMode({ ...base, value: money(0) }), "otp", "a zero-value quote still carries money");
  // Nothing with a value attached — a job card, or a document with no source.
  assert.equal(resolveIdentityMode({ ...base, value: money(null) }), "link");
});

test("the threshold only exempts what it is set to exempt", () => {
  const base = { policy: "money" as const, minValue: 5000 };
  assert.equal(resolveIdentityMode({ ...base, value: money(4999.99) }), "link");
  assert.equal(resolveIdentityMode({ ...base, value: money(5000) }), "otp", "at the threshold is above it");
  assert.equal(resolveIdentityMode({ ...base, value: money(5000.01) }), "otp");
});

test("off and always mean what they say", () => {
  assert.equal(resolveIdentityMode({ policy: "off", minValue: 0, value: money(999999) }), "link");
  assert.equal(resolveIdentityMode({ policy: "always", minValue: 0, value: money(null) }), "otp");
});

test("a person preparing the document outranks the policy", () => {
  // Both directions. Someone looking at the specific document in front of them
  // knows something the setting cannot.
  assert.equal(
    resolveIdentityMode({ explicit: "link", policy: "always", minValue: 0, value: money(50000) }),
    "link",
  );
  assert.equal(
    resolveIdentityMode({ explicit: "otp", policy: "off", minValue: 0, value: money(null) }),
    "otp",
  );
});

test("unreadable settings fall back to the safe default rather than off", () => {
  // A corrupt or missing value must not quietly disable verification — that is
  // the failure nobody notices until it matters.
  for (const bad of [null, undefined, "", "  ", "nonsense", "OFF!", "true"]) {
    assert.equal(parseOtpPolicy(bad), "money", `${JSON.stringify(bad)} must fall back to the default`);
  }
  assert.equal(parseOtpPolicy("off"), "off");
  assert.equal(parseOtpPolicy(" Always "), "always");

  for (const bad of [null, "", "abc", "-5", "NaN"]) {
    assert.equal(parseOtpMinValue(bad), 0, "an unreadable threshold means 'any amount', not 'none'");
  }
  assert.equal(parseOtpMinValue("2500.5"), 2500.5);
});

test("changing who gets challenged is owner-only and audited", () => {
  const action = read("src/app/actions/signingSecuritySettings.ts");
  // Turning verification off is a security decision; it should be attributable
  // to a person rather than appearing in a settings table with no history.
  assert.match(action, /requireOwner\(\)/);
  assert.match(action, /logAudit\(/);
  assert.match(action, /signing\.identity_policy_changed/);
});
