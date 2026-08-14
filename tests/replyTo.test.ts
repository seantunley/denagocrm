import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  MAX_REPLY_TO,
  defaultReplyTo,
  isReplyToAddress,
  parseReplyTo,
} from "../src/lib/replyToAddresses";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Mail leaves the CRM as the WORKSPACE, so a customer's reply lands wherever
 * SMTP_FROM delivers — the shared mailbox the IMAP sync files against the record,
 * or the person who wrote it, but not both. `Reply-To` takes a list, which is what
 * lets it be both.
 *
 * The value is free-form and reaches a mail header, so most of what follows is
 * about the header, not the feature.
 */

/* ── header injection ───────────────────────────────────────────────────── */

test("a newline in the field cannot start a second header", () => {
  // THE REASON THIS IS VALIDATED AT ALL. A header value containing CR or LF ends
  // the header and begins a new one — which is how a free-form field becomes a
  // way to add `Bcc:` to mail the workspace sends, to recipients nobody sees.
  for (const attack of [
    "a@b.com\r\nBcc: victim@example.com",
    "a@b.com\nBcc: victim@example.com",
    "a@b.com\rX-Evil: 1",
    "a@b.com%0d%0aBcc:victim@example.com",
    "a@b.com Bcc: victim@example.com",
  ]) {
    const result = parseReplyTo(attack);
    assert.equal(result.ok, false, `must reject: ${JSON.stringify(attack)}`);
  }
});

test("injection is REFUSED, never stripped", () => {
  // Silently dropping the bad part would send the mail anyway, with replies going
  // somewhere the sender did not choose and was not told about. A refusal they can
  // read is better than a header they cannot see.
  const result = parseReplyTo("good@example.com, bad\r\nBcc: x@y.com");
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.invalid.length === 1, "the offending part is named back");
});

test("display names and angle brackets are refused too", () => {
  // Legal RFC 5322, and deliberately unsupported: every one of them widens what
  // has to be escaped correctly on the way into a header, for a field that is
  // filled from a default and occasionally edited.
  for (const value of ["Sean <sean@example.com>", '"Sean, T" <s@e.com>', "sean@example.com (comment)"]) {
    assert.equal(isReplyToAddress(value), false, `must reject: ${value}`);
  }
});

test("an address must actually look like one", () => {
  for (const bad of ["", "notanaddress", "@example.com", "a@", "a@b", "a b@example.com", "a@ex ample.com"]) {
    assert.equal(isReplyToAddress(bad), false, `must reject: ${JSON.stringify(bad)}`);
  }
  for (const good of ["a@b.co", "first.last+tag@sub.example.co.za", "CAPS@Example.COM"]) {
    assert.equal(isReplyToAddress(good), true, `must accept: ${good}`);
  }
});

test("the list is bounded", () => {
  const many = Array.from({ length: MAX_REPLY_TO + 1 }, (_, i) => `a${i}@example.com`).join(", ");
  assert.equal(parseReplyTo(many).ok, false, "a header is not an unbounded list");
});

/* ── the behaviour people will notice ───────────────────────────────────── */

test("empty means no Reply-To, and that is a choice rather than a failure", () => {
  // Without the header, replies go to the From address — exactly what happened
  // before this field existed. Clearing it must therefore succeed, not error.
  for (const blank of ["", "   ", " , ; "]) {
    assert.deepEqual(parseReplyTo(blank), { ok: true, value: null });
  }
});

test("both separators work, and spacing is forgiven", () => {
  assert.deepEqual(parseReplyTo(" a@x.com ,b@y.com ; c@z.com "), {
    ok: true,
    value: "a@x.com, b@y.com, c@z.com",
  });
});

test("the same address twice is one address", () => {
  // The default is "the sender, then the CRM mailbox". A rep who IS the shared
  // mailbox would otherwise get themselves listed twice in every message.
  assert.deepEqual(parseReplyTo("a@x.com, A@X.com"), { ok: true, value: "a@x.com" });
});

test("the default is the sender first, then the CRM mailbox", () => {
  // Order matters: some clients show only the first address, and the human should
  // be the one a recipient sees.
  assert.equal(
    defaultReplyTo({ senderEmail: "rep@acme.com", crmMailbox: "crm@acme.com" }),
    "rep@acme.com, crm@acme.com",
  );
});

test("the default degrades to whatever is actually available", () => {
  assert.equal(defaultReplyTo({ senderEmail: "rep@acme.com", crmMailbox: null }), "rep@acme.com");
  assert.equal(defaultReplyTo({ senderEmail: null, crmMailbox: "crm@acme.com" }), "crm@acme.com");
  assert.equal(defaultReplyTo({ senderEmail: null, crmMailbox: null }), "", "an empty field, not a broken one");
});

test("an IMAP login that is not an address is left out", () => {
  // IMAP_USER is a LOGIN, and plenty of servers take a bare username. Putting one
  // in Reply-To would produce mail whose replies bounce.
  assert.equal(defaultReplyTo({ senderEmail: "rep@acme.com", crmMailbox: "crmuser" }), "rep@acme.com");
});

test("a hostile value cannot reach the header through the DEFAULT either", () => {
  // The default is composed from settings and a user record, not from a form — but
  // both are editable by somebody, so it goes through the same validation.
  assert.equal(defaultReplyTo({ senderEmail: "a@b.com\r\nBcc: x@y.com", crmMailbox: null }), "");
});

/* ── the wiring ─────────────────────────────────────────────────────────── */

test("the action refuses an invalid list rather than sending without it", () => {
  const code = shipped("src/app/actions/emails.ts");
  const parse = code.indexOf("parseReplyTo(");
  const send = code.indexOf("await sendEmail({");
  assert.ok(parse > 0 && parse < send, "the list must be validated before the send");
  assert.match(code, /if \(!replyTo\.ok\) \{[\s\S]*?return \{ error:/, "and a bad list must stop the send");
  assert.match(code, /replyTo: replyTo\.value \?\? undefined/, "the validated value is what is sent");
});

test("sendEmail passes it as a nodemailer field, not a raw header", () => {
  // nodemailer parses and encodes addresses for `replyTo`; an arbitrary header
  // would be passed through verbatim.
  const code = shipped("src/lib/email.ts");
  assert.match(code, /replyTo\?: string;/);
  assert.match(code, /\.\.\.\(input\.replyTo \? \{ replyTo: input\.replyTo \} : \{\}\)/);
});

test("omitting it changes nothing about the message", () => {
  // Every other caller of sendEmail passes no replyTo, and their mail must be
  // byte-for-byte what it was — hence the spread rather than `replyTo: undefined`.
  const code = shipped("src/lib/email.ts");
  assert.doesNotMatch(code, /replyTo: input\.replyTo,/, "an unconditional field would set it to undefined");
});

test("both composer call sites pass a default", () => {
  // The prop defaults to "" so an un-updated caller still renders — which means a
  // missed call site would be invisible rather than a type error.
  for (const rel of ["src/app/(app)/leads/[id]/page.tsx", "src/app/(app)/contacts/[id]/page.tsx"]) {
    const code = shipped(rel);
    assert.match(code, /composerReplyToDefault\(user\.email\)/, `${rel} must resolve the default`);
    assert.match(code, /defaultReplyTo=\{replyToDefault\}/, `${rel} must pass it to the composer`);
  }
});

test("the field is not type=email, which would reject the default", () => {
  // `type="email"` validates a SINGLE address, so the browser would refuse the
  // two-address default this field exists to provide — and the failure would look
  // like the form silently not submitting.
  const code = shipped("src/components/EmailComposer.tsx");
  const start = code.indexOf('name="replyTo"');
  assert.ok(start > 0, "the field must exist");
  const field = code.slice(start, code.indexOf("/>", start));
  assert.doesNotMatch(field, /type="email"/);
  assert.match(field, /type="text"/);
});

test("the audit records where replies were directed", () => {
  // The header exists only in the recipient's copy once the message has left, so
  // this is the only place it can be recovered.
  assert.match(shipped("src/app/actions/emails.ts"), /replies to: \$\{replyTo\.value\}/);
});

test("the default resolver cannot take down the pages that render it", () => {
  // It runs on the lead and contact pages. A settings lookup that raised would
  // take those down for a pre-filled field — the trade emailBrand already makes.
  const code = shipped("src/lib/replyToDefault.ts");
  assert.match(code, /try \{[\s\S]*?\} catch \{[\s\S]*?crmMailbox = null;/);
  // Resolved through the same path imapSync uses, so a workspace with its own
  // mail credentials gets its own address rather than the platform's.
  assert.match(code, /resolveIntegrationBundle\(tenantId, "imap"\)/);
});
