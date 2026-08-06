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

test("a timestamp token is bound to the exact document it covers", () => {
  // A real token captured from a live authority would be ideal, but it expires
  // as evidence and pins a date into the repository. What matters structurally
  // is that the check is against the digest, so a token filed against the wrong
  // document is caught.
  const digest = crypto.createHash("sha256").update("a document").digest();
  const other = crypto.createHash("sha256").update("a different document").digest();
  const fakeToken = Buffer.concat([Buffer.from("prefix"), digest, Buffer.from("suffix")]).toString("base64");

  assert.equal(timestampCoversDigest(fakeToken, digest), true);
  assert.equal(timestampCoversDigest(fakeToken, other), false, "a token must not vouch for another document");
  assert.equal(timestampCoversDigest("not base64 !!", digest), false);
  assert.equal(timestampCoversDigest("", digest), false);
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

test("the certificate does not claim to carry its own timestamp", () => {
  // The hash covers the certificate, so a token over that hash cannot be printed
  // inside it. Saying so is better than a claim that cannot hold.
  const complete = read("src/lib/signing/complete.ts");
  assert.match(complete, /hash it covers includes this certificate/);
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
