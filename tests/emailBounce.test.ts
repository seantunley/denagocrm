import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { simpleParser } from "mailparser";
import { bouncedLabel, readBounce } from "../src/lib/emailBounce";
import { openedFact } from "../src/lib/emailOpenTracking";

const code = (path: string) => readFileSync(path, "utf8");
const parse = (raw: string | Buffer) => simpleParser(raw);

test("the MWEB spam refusal is read: who, why, and which email (2026-10-12)", async () => {
  const bounce = readBounce(await parse(readFileSync("tests/fixtures/bounce-exim-dsn.eml")));
  assert.ok(bounce);
  assert.deepEqual(bounce.recipients, ["erikjvr@mweb.co.za"]);
  assert.equal(bounce.reason, "550 High probability of spam");
  // The original's own header — never a "Message-ID:" line in its body, nor the notice's own id.
  assert.deepEqual(bounce.originalMessageIds, ["<a1b2c3d4-e5f6-7890@denagocpt.co.za>"]);
});

test("a plain-text Exim bounce (no delivery report) is read too", async () => {
  const raw = [
    "From: Mail Delivery System <Mailer-Daemon@bayek.aserv.co.za>",
    "To: crm@denagocpt.co.za",
    "X-Failed-Recipients: Someone@Example.com",
    "Subject: Mail delivery failed: returning message to sender",
    "",
    "This message was created automatically by mail delivery software.",
    "",
    "  someone@example.com",
    "    SMTP error from remote mail server after RCPT TO:<someone@example.com>:",
    "    550 5.1.1 User unknown",
    "",
    "------ This is a copy of the message, including all the headers. ------",
    "",
    "From: crm@denagocpt.co.za",
    "Message-ID: <plain-1@denagocpt.co.za>",
    "Subject: Hello",
    "",
    "Body",
  ].join("\r\n");
  const bounce = readBounce(await parse(raw));
  assert.ok(bounce);
  assert.deepEqual(bounce.recipients, ["someone@example.com"]);
  assert.equal(bounce.reason, "550 5.1.1 User unknown");
  assert.deepEqual(bounce.originalMessageIds, ["<plain-1@denagocpt.co.za>"]);
});

test("a 'still trying' warning is not a bounce", async () => {
  const raw = readFileSync("tests/fixtures/bounce-exim-dsn.eml", "utf8")
    .replace(/^X-Failed-Recipients: .*\r?\n/m, "")
    .replace("Action: failed", "Action: delayed")
    .replace("Status: 5.0.0", "Status: 4.4.7");
  assert.equal(readBounce(await parse(raw)), null);
});

test("an ordinary customer email is never read as a bounce, whatever its subject", async () => {
  const raw = [
    "From: Erik <erikjvr@mweb.co.za>",
    "To: crm@denagocpt.co.za",
    "Subject: Mail delivery failed? I never got the quote",
    "Message-ID: <x@mweb.co.za>",
    "",
    "Action: failed",
    "Final-Recipient: rfc822; someone@else.com",
  ].join("\r\n");
  assert.equal(readBounce(await parse(raw)), null);
});

test("the timeline says it plainly, and only for a sent email that bounced", () => {
  const at = new Date("2026-10-12T10:00:05Z");
  assert.match(bouncedLabel({ direction: "outbound", bouncedAt: at, bounceReason: "550 High probability of spam" }) ?? "", /^⚠ Not delivered · .+ — 550 High probability of spam$/);
  assert.equal(bouncedLabel({ direction: "outbound", bouncedAt: null }), null);
  assert.equal(bouncedLabel({ direction: "inbound", bouncedAt: at }), null);
});

test("DAX is told an email was not delivered", () => {
  const fact = openedFact({ type: "email", direction: "outbound", messageId: "<m@d>", bouncedAt: new Date("2026-10-12T10:00:05Z"), bounceReason: "550 High probability of spam" });
  assert.deepEqual((fact as { notDelivered?: unknown }).notDelivered, { at: "2026-10-12T10:00:05.000Z", reason: "550 High probability of spam" });
  assert.match(code("src/lib/emailOpenTracking.ts"), /`notDelivered`: .*NOT delivered/);
  assert.match(code("src/lib/crmAssistant.ts"), /bouncedAt: true, bounceReason: true/);
});

test("wiring: the mailbox sync reads bounces before tickets or replies, and every timeline shows them", () => {
  const sync = code("src/lib/imapSync.ts");
  assert.match(sync, /const bounce = readBounce\(parsed\);\s*if \(bounce\) return fileBounce\(bounce, parsed\);\s*[\s\S]*const mailbox = await matchSupportMailbox\(parsed\);/);
  // Stamped once, only while not already stamped.
  assert.match(sync, /where: \{ id: sent\.id, bouncedAt: null \}/);
  // Told to whoever sent it.
  assert.match(sync, /"email_bounced",\s*[\s\S]{0,120}sent \? \{ userId: sent\.userId \} : \{\}/);
  assert.match(code("src/lib/push.ts"), /id: "email_bounced"/);
  assert.match(code("src/components/LeadTimeline.tsx"), /bounced: bouncedLabel\(communication\)/);
  assert.match(code("src/components/CommsTimeline.tsx"), /bouncedLabel\(c\)/);
  assert.match(code("src/lib/fleetRollup.ts"), /bouncedAt: true,\s*bounceReason: true/);
  const migration = code("prisma/migrations/20261026120000_communication_bounce/migration.sql");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "bouncedAt" TIMESTAMP\(3\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "bounceReason" TEXT/);
});

test("the automatic senders keep the Message-ID a bounce is matched on", () => {
  assert.match(code("src/lib/reviewRequests.ts"), /messageId: res\.messageId \?\? null/);
  assert.match(code("src/lib/serviceReminders.ts"), /messageId: result\.messageId \?\? null/);
  assert.match(code("src/lib/journeyStepExecutor.ts"), /recordCommunication\(context, "email", [^\n]*result\.messageId\)/);
});
