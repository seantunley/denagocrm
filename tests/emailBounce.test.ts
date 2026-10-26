import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { simpleParser } from "mailparser";
import { bounceLines, bouncedLabel, newBounceLines, readBounce, tidyReason } from "../src/lib/emailBounce";
import { openedFact } from "../src/lib/emailOpenTracking";

const code = (path: string) => readFileSync(path, "utf8");
const parse = (raw: string | Buffer) => simpleParser(raw);

test("the MWEB spam refusal is read: who, why, and which email (2026-10-12)", async () => {
  const bounce = readBounce(await parse(readFileSync("tests/fixtures/bounce-exim-dsn.eml")));
  assert.ok(bounce);
  assert.deepEqual(bounce.failures, [{ address: "customer@isp.example", reason: "High probability of spam (550)" }]);
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
  assert.deepEqual(bounce.failures, [{ address: "someone@example.com", reason: "User unknown (550 5.1.1)" }]);
  assert.deepEqual(bounce.originalMessageIds, ["<plain-1@denagocpt.co.za>"]);
});

test("a mixed report keeps only the recipients that FAILED, each with its own reason (review of #907)", async () => {
  const report = [
    "Reporting-MTA: dns; bayek.aserv.co.za",
    "",
    "Action: delivered",
    "Final-Recipient: rfc822; customer@example.com",
    "Status: 2.0.0",
    "Diagnostic-Code: smtp; 250 OK",
    "",
    "Action: failed",
    "Final-Recipient: rfc822;cc@example.com",
    "Status: 5.1.1",
    "Diagnostic-Code: smtp; 550 5.1.1 No such",
    "  mailbox here",
    "",
    "Action: delayed",
    "Final-Recipient: rfc822; slow@example.com",
    "Status: 4.4.7",
    "",
    "Action: failed",
    "Final-Recipient: rfc822; full@example.com",
    "Status: 5.2.2",
    "Diagnostic-Code: smtp; 552 Mailbox full",
    "",
  ].join("\n");
  const raw = readFileSync("tests/fixtures/bounce-exim-dsn.eml", "utf8")
    .replace(/^X-Failed-Recipients: .*\r?\n/m, "X-Failed-Recipients: cc@example.com, full@example.com\n")
    .replace(/Reporting-MTA: dns; bayek\.aserv\.co\.za[\s\S]*?Diagnostic-Code: smtp; 550 High probability of spam\r?\n/, report);
  const bounce = readBounce(await parse(raw));
  assert.ok(bounce);
  assert.deepEqual(bounce.failures, [
    { address: "cc@example.com", reason: "No such mailbox here (550 5.1.1)" },
    { address: "full@example.com", reason: "Mailbox full (552)" },
  ]);
  // A report with no failure at all — delivered and delayed only — is no bounce.
  const noneFailed = raw.replace(/^X-Failed-Recipients: .*\r?\n/m, "").replace(/Action: failed/g, "Action: delivered");
  assert.equal(readBounce(await parse(noneFailed)), null);
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
    "From: A Customer <customer@isp.example>",
    "To: crm@denagocpt.co.za",
    "Subject: Mail delivery failed? I never got the quote",
    "Message-ID: <x@mweb.co.za>",
    "",
    "Action: failed",
    "Final-Recipient: rfc822; someone@else.com",
  ].join("\r\n");
  assert.equal(readBounce(await parse(raw)), null);
});

test("an email to several people records only the address that failed, once each", () => {
  const cc = { failures: [{ address: "cc@example.com", reason: "550 User unknown" }], originalMessageIds: ["<m@d>"] };
  const first = bounceLines(cc);
  assert.deepEqual(first, ["cc@example.com: 550 User unknown"]);
  const recorded = first.join("\n");
  // The same address again — even worded differently — adds nothing.
  assert.deepEqual(newBounceLines(recorded, bounceLines({ ...cc, failures: [{ address: "cc@example.com", reason: "550 5.1.1 No such user" }] })), []);
  // The other recipient failing later is added.
  assert.deepEqual(newBounceLines(recorded, bounceLines({ ...cc, failures: [{ address: "to@example.com", reason: "550 User unknown" }] })), ["to@example.com: 550 User unknown"]);
  // The badge names who it failed for, not just that something failed.
  const label = bouncedLabel({ direction: "outbound", bouncedAt: new Date(), bounceReason: `${recorded}\nto@example.com: 550 User unknown` }) ?? "";
  assert.match(label, /cc@example\.com: User unknown \(550\); to@example\.com: User unknown \(550\)$/);
  // No address in the notice: the reason alone, filed once.
  assert.deepEqual(bounceLines({ failures: [{ address: null, reason: "550 Rejected" }], originalMessageIds: ["<m@d>"] }), ["550 Rejected"]);
  assert.deepEqual(newBounceLines("550 Rejected", ["550 Rejected"]), []);
});

test("the server's reason reads as words, its code once at the end (2026-10-26)", () => {
  // Gmail's real reply from the live test: the code on every line, a help link, a tracking id.
  const gmail =
    "550-5.1.1 The email account that you tried to reach does not exist. Please try 550-5.1.1 double-checking the recipient's email address for typos or " +
    "550-5.1.1 unnecessary spaces. For more information, go to 550 5.1.1  https://support.google.com/mail/?p=NoSuchUser ffacd0b85a97d-48e3ecdc0c9si13115348f8f.76 - gsmtp";
  const tidy = "The email account that you tried to reach does not exist. Please try double-checking the recipient's email address for typos or unnecessary spaces. (550 5.1.1)";
  assert.equal(tidyReason(gmail), tidy);
  assert.equal(tidyReason(`smtp; ${gmail}`), tidy);
  assert.equal(tidyReason("550 High probability of spam"), "High probability of spam (550)");
  assert.equal(tidyReason("550-Mailbox unavailable 550-try later"), "Mailbox unavailable try later (550)");
  // A number in the words is not the reply's code.
  assert.equal(tidyReason("421 Try again in 550 seconds"), "Try again in 550 seconds (421)");
  assert.equal(tidyReason("550 5.1.1 Please wait 550 seconds"), "Please wait 550 seconds (550 5.1.1)");
  // No code: left as it is. Already tidy: unchanged — so rows stored before this read the same.
  assert.equal(tidyReason("The receiving mail server refused it."), "The receiving mail server refused it.");
  for (const s of [tidy, "High probability of spam (550)"]) assert.equal(tidyReason(s), s);
  // The badge tidies a reason stored raw (the live test's rows were).
  const label = bouncedLabel({ direction: "outbound", bouncedAt: new Date(), bounceReason: `a@b.co: ${gmail.slice(0, 300)}` }) ?? "";
  assert.match(label, /— a@b\.co: The email account that you tried to reach does not exist\. .+ unnecessary spaces\. \(550 5\.1\.1\)$/);
});

test("the timeline says it plainly, and only for a sent email that bounced", () => {
  const at = new Date("2026-10-12T10:00:05Z");
  assert.match(bouncedLabel({ direction: "outbound", bouncedAt: at, bounceReason: "550 High probability of spam" }) ?? "", /^⚠ Not delivered · .+ — High probability of spam \(550\)$/);
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
  // The stamp and the history note commit together (review of #907): a failed note undoes the stamp, so the retry files it again.
  assert.match(sync, /prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?where: \{ id: sent\.id, bounceReason: current\.bounceReason \}[\s\S]*?bounceNotifiedAt: null,[\s\S]*?await logAuditStrict\([\s\S]*?tx,\s*\);/);
  // A lost compare-and-set re-reads and tries again, so a concurrent second address isn't dropped.
  assert.match(sync, /for \(let attempt = 0; attempt < BOUNCE_CAS_ATTEMPTS; attempt\+\+\) \{\s*const current = await prisma\.communication\.findUnique/);
  // Told to whoever sent it — and an unmatched notice never broadcasts.
  assert.match(sync, /"email_bounced",\s*\{ userId: email\.userId \}/);
  assert.equal(sync.match(/"email_bounced"/g)?.length, 1);
  // The alert is owed until the push call returns, and every sync retries what is owed.
  // …and "told" means a push service ACCEPTED it: 0 accepted (refused, no device, push off) stays owed.
  assert.match(sync, /const accepted = await push\([\s\S]*?\);\s*if \(accepted < 1\) continue;[^\n]*\s*await prisma\.communication\.updateMany\(\{\s*where: \{ id: email\.id, bounceNotifiedAt: null, bounceReason: email\.bounceReason \},\s*data: \{ bounceNotifiedAt: new Date\(\) \}/);
  // The real-database scenarios run in CI.
  assert.match(code("package.json"), /"test:email-bounces": "tsx --tsconfig tsconfig\.harness\.json scripts\/test-email-bounces\.ts"/);
  assert.match(code(".github/workflows/security-rbac-ci.yml"), /run: npm run test:email-bounces/);
  assert.match(sync, /await notifyBounces\(\)\.catch\(.*\);\s*await client\.connect\(\);/);
  // Never "their latest email": only the email's own Message-ID marks one.
  assert.doesNotMatch(sync, /BOUNCE_LOOKBACK|occurredAt: \{ gte/);
  assert.match(code("src/lib/push.ts"), /id: "email_bounced"/);
  assert.match(code("src/components/LeadTimeline.tsx"), /bounced: bouncedLabel\(communication\)/);
  assert.match(code("src/components/CommsTimeline.tsx"), /bouncedLabel\(c\)/);
  assert.match(code("src/lib/fleetRollup.ts"), /bouncedAt: true,\s*bounceReason: true/);
  const migration = code("prisma/migrations/20261026120000_communication_bounce/migration.sql");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "bouncedAt" TIMESTAMP\(3\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "bounceReason" TEXT/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "bounceNotifiedAt" TIMESTAMP\(3\)/);
});

test("the automatic senders keep the Message-ID a bounce is matched on", () => {
  assert.match(code("src/lib/reviewRequests.ts"), /messageId: res\.messageId \?\? null/);
  assert.match(code("src/lib/serviceReminders.ts"), /messageId: result\.messageId \?\? null/);
  assert.match(code("src/lib/journeyStepExecutor.ts"), /recordCommunication\(context, "email", [^\n]*result\.messageId\)/);
});
