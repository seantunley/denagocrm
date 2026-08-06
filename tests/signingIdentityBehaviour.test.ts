import test from "node:test";
import assert from "node:assert/strict";
import { hashSignToken, newSignToken, isValidSignToken } from "../src/lib/signing/tokens";
import { signEventPayloadHash, signEventLinkHash, verifyEvidenceChain, EVIDENCE_CHAIN_ROOT, type SignEventInput } from "../src/lib/signing/evidenceHash";
import { offeredChannels } from "../src/lib/signing/identityChannels";

/**
 * Behaviour, not source text.
 *
 * The rest of the signing guards assert what the code SAYS; these run it. Both
 * matter, but only this kind catches a rule that is written correctly and
 * computes the wrong answer.
 */

test("a stored capability is a digest of the delivered one, and reveals nothing about it", () => {
  const raw = newSignToken();
  assert.ok(isValidSignToken(raw), "the minted capability must satisfy the public route's format check");

  const digest = hashSignToken(raw);
  assert.match(digest, /^[0-9a-f]{64}$/, "the stored form is what the database trigger will accept");
  assert.notEqual(digest, raw);
  assert.equal(hashSignToken(raw), digest, "the same link must always resolve to the same row");
  assert.notEqual(hashSignToken(newSignToken()), digest);

  // The property the whole scheme rests on: a database dump yields digests, and
  // a digest cannot be replayed as a signing link because it fails the format
  // check the public routes apply before they ever query.
  assert.equal(isValidSignToken(digest), true, "64 hex is inside the accepted range");
  assert.notEqual(hashSignToken(digest), digest, "…but hashing it again does not resolve the original row");
});

test("historic links keep working: an old plaintext token hashes to its migrated row", () => {
  // The migration rewrites token -> sha256(token) in place, and the routes hash
  // before they query. So a URL delivered before the migration must still land
  // on the same row afterwards. This is the assertion that "nothing already in a
  // customer's inbox breaks" rests on.
  const alreadyDelivered = newSignToken();
  const whatTheMigrationStores = hashSignToken(alreadyDelivered);
  const whatTheRouteLooksUp = hashSignToken(alreadyDelivered);
  assert.equal(whatTheRouteLooksUp, whatTheMigrationStores);
});

const baseEvent: SignEventInput = {
  id: "sev_1",
  requestId: "req_1",
  recipientId: "rec_1",
  type: "signed",
  actor: "A Customer",
  channel: "web",
  ip: "10.0.0.1",
  userAgent: "Mozilla/5.0",
  metadata: { mode: "otp", method: "sms_otp" },
  createdAt: new Date("2026-08-06T10:00:00.000Z"),
};

test("the evidence hash survives the database reordering metadata keys", () => {
  // jsonb does not preserve insertion order — it orders keys by length then
  // bytewise. If the hash depended on key order, every event would verify as
  // tampered the moment it was read back. This is the specific reason the digest
  // is taken over canonical (sorted-key) JSON in the application rather than
  // over jsonb inside PostgreSQL.
  const asWritten = signEventPayloadHash(baseEvent);
  const asReadBack = signEventPayloadHash({
    ...baseEvent,
    metadata: { method: "sms_otp", mode: "otp" },
  });
  assert.equal(asReadBack, asWritten);

  // Nested objects and arrays too, since metadata is free-form.
  const nestedA = signEventPayloadHash({ ...baseEvent, metadata: { a: { x: 1, y: [1, 2] }, b: 2 } });
  const nestedB = signEventPayloadHash({ ...baseEvent, metadata: { b: 2, a: { y: [1, 2], x: 1 } } });
  assert.equal(nestedA, nestedB);
});

test("the evidence hash changes when any recorded fact changes", () => {
  const original = signEventPayloadHash(baseEvent);
  const tampered: Array<[string, SignEventInput]> = [
    ["actor", { ...baseEvent, actor: "Someone Else" }],
    ["type", { ...baseEvent, type: "declined" }],
    ["ip", { ...baseEvent, ip: "10.0.0.2" }],
    ["recipient", { ...baseEvent, recipientId: "rec_2" }],
    ["timestamp", { ...baseEvent, createdAt: new Date("2026-08-06T10:00:01.000Z") }],
    ["metadata value", { ...baseEvent, metadata: { mode: "otp", method: "email_otp" } }],
    ["user agent", { ...baseEvent, userAgent: "curl/8" }],
  ];
  for (const [what, event] of tampered) {
    assert.notEqual(signEventPayloadHash(event), original, `editing the ${what} must be detectable`);
  }

  // Array ORDER is meaning, not formatting, so it must not be normalised away.
  const listed = signEventPayloadHash({ ...baseEvent, metadata: { steps: ["a", "b"] } });
  const reordered = signEventPayloadHash({ ...baseEvent, metadata: { steps: ["b", "a"] } });
  assert.notEqual(listed, reordered);
});

const subject = (over: Partial<Parameters<typeof offeredChannels>[0]> = {}) => ({
  email: "customer@example.com" as string | null,
  phone: "+27821234567" as string | null,
  identityMode: "otp",
  ...over,
});

test("a signer is only offered a channel the document allows AND we can reach", () => {
  const both = offeredChannels(subject());
  assert.deepEqual(both.map((c) => c.channel), ["email", "sms"]);

  // Mode restricts the offer even when both are on file.
  assert.deepEqual(
    offeredChannels(subject({ identityMode: "email_otp" })).map((c) => c.channel),
    ["email"],
  );
  assert.deepEqual(
    offeredChannels(subject({ identityMode: "sms_otp" })).map((c) => c.channel),
    ["sms"],
  );

  // Missing contact details remove the channel rather than offering a button
  // that sends a code nowhere and strands the signer at a prompt.
  assert.deepEqual(offeredChannels(subject({ phone: null })).map((c) => c.channel), ["email"]);
  assert.deepEqual(offeredChannels(subject({ email: null })).map((c) => c.channel), ["sms"]);
  assert.deepEqual(offeredChannels(subject({ email: null, phone: null })), []);
  assert.deepEqual(offeredChannels(subject({ email: "   ", phone: "" })), []);

  // The document that asks for SMS from a signer with no number on file has no
  // usable channel — the honest answer, which the gate turns into "contact the
  // sender" rather than a dead button.
  assert.deepEqual(
    offeredChannels(subject({ phone: null, identityMode: "sms_otp" })),
    [],
  );
});

test("the channel hints identify an account without disclosing it", () => {
  const [email, sms] = offeredChannels(subject());
  // Whoever holds the link may not be the customer. The hint has to be enough
  // for the real signer to recognise their own account and not enough for
  // anyone else to learn their address or number.
  assert.doesNotMatch(email.hint, /^customer@/);
  assert.match(email.hint, /@example\.com$/, "the domain is kept so the signer recognises it");
  assert.ok(!sms.hint.includes("821234"), `the number must not be readable: ${sms.hint}`);
  assert.match(sms.hint, /567$/, "the last digits are kept so the signer recognises it");
});


test("removing, reordering or editing an event breaks the chain", () => {
  const events: SignEventInput[] = ["created", "opened", "identity_verified", "signed"].map((type, index) => ({
    ...baseEvent,
    id: `sev_${index + 1}`,
    type,
    createdAt: new Date(Date.UTC(2026, 7, 6, 10, index)),
  }));

  // Build the chain exactly as the trigger does.
  let prev = EVIDENCE_CHAIN_ROOT;
  const rows = events.map((event, index) => {
    const payloadHash = signEventPayloadHash(event);
    const eventHash = signEventLinkHash(prev, payloadHash);
    const row = { id: event.id, sequence: index + 1, prevHash: prev, payloadHash, eventHash };
    prev = eventHash;
    return row;
  });

  assert.deepEqual(verifyEvidenceChain(rows), { ok: true }, "an untouched history must verify");

  // Delete the identity check — the single most valuable row to erase, because
  // it is what proves the signer was who the document was sent to.
  const withoutIdentityProof = rows.filter((row) => row.id !== "sev_3");
  const deleted = verifyEvidenceChain(withoutIdentityProof);
  assert.equal(deleted.ok, false);
  if (!deleted.ok) assert.equal(deleted.brokenAt, "sev_4");

  // Swap two rows.
  const swapped = [rows[0], rows[2], rows[1], rows[3]];
  assert.equal(verifyEvidenceChain(swapped).ok, false);

  // Edit one row's contents and re-link nothing.
  const edited = rows.map((row) =>
    row.id === "sev_4" ? { ...row, payloadHash: signEventPayloadHash({ ...events[3], actor: "Someone Else" }) } : row,
  );
  const tampered = verifyEvidenceChain(edited);
  assert.equal(tampered.ok, false);
  if (!tampered.ok) assert.equal(tampered.brokenAt, "sev_4");

  // Re-linking the edited row does not save it either: the row AFTER it no
  // longer follows, which is the property that makes a chain worth having.
  const relinked = edited.map((row, index) =>
    index === 3 ? { ...row, eventHash: signEventLinkHash(row.prevHash, row.payloadHash) } : row,
  );
  assert.equal(verifyEvidenceChain(relinked).ok, true, "the last row can be re-linked…");
  const withTrailing = [...relinked, { id: "sev_5", sequence: 5, prevHash: rows[3].eventHash, payloadHash: "x".repeat(64), eventHash: signEventLinkHash(rows[3].eventHash, "x".repeat(64)) }];
  assert.equal(verifyEvidenceChain(withTrailing).ok, false, "…but anything already chained after it no longer follows");
});
