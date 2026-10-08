import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  SECRET_MASK,
  outboundFailureSummary,
  outboundTimelineEntry,
  redactOutbound,
} from "../src/lib/outboundMessageLog";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

// Synthetic, built at runtime so the secret scanner doesn't read it as a key.
const TOKEN = ["tok", "test", "signing", "link", "0000"].join("_");

test("a signing link is stored as its route shape, never the working token", () => {
  const entry = outboundTimelineEntry(
    {
      channel: "email",
      to: "jane@example.com",
      subject: "Please sign your document: Quote Q-1026",
      text: `Hi Jane,\n\nOpen and sign here:\nhttps://crm.example.co.za/signing/${TOKEN}\n\nThank you`,
    },
    { contactId: "c1", leadId: "l1", label: "Signing invitation", secrets: [TOKEN] },
  );
  assert.ok(!entry.body.includes(TOKEN), "raw token must not reach the timeline");
  assert.match(entry.body, /\/signing\/(\[redacted\]|••••••)/);
  assert.match(entry.body, /^\[Signing invitation\]\nTo: jane@example\.com\n\nHi Jane,/);
  assert.equal(entry.subject, "Please sign your document: Quote Q-1026");
});

test("capability links are redacted even when the caller forgot to pass the secret", () => {
  const body = redactOutbound(`Sign: https://x.co/signing/${TOKEN} and survey https://x.co/s/${TOKEN}`);
  assert.ok(!body.includes(TOKEN));
});

test("a one-time code is masked in the body, the subject and a failure summary", () => {
  const record = { contactId: "c1", secrets: ["482913"] };
  const msg = { channel: "sms" as const, to: "+27821234567", subject: "Code 482913", text: "Your verification code is 482913. It expires in 10 minutes." };
  const entry = outboundTimelineEntry(msg, record);
  assert.ok(!entry.body.includes("482913"));
  assert.ok(entry.body.includes(`Your verification code is ${SECRET_MASK}.`));
  assert.equal(entry.subject, `Code ${SECRET_MASK}`);
  assert.ok(!outboundFailureSummary(msg, record, "rejected 482913").includes("482913"));
});

test("short or empty secrets never mask ordinary text", () => {
  assert.equal(redactOutbound("Quote 12 for R 1 200", ["", null, undefined, "12"]), "Quote 12 for R 1 200");
});

test("the row carries the right type, direction, record links and provider id", () => {
  const at = new Date("2026-09-30T10:00:00Z");
  const entry = outboundTimelineEntry(
    { channel: "whatsapp", to: "27821234567", text: "hi", messageId: "wamid.ABC", occurredAt: at, attachments: ["Q-1026.pdf"] },
    { contactId: "c9", leadId: null },
  );
  assert.equal(entry.type, "whatsapp");
  assert.equal(entry.direction, "outbound");
  assert.equal(entry.contactId, "c9");
  assert.equal(entry.leadId, null);
  assert.equal(entry.messageId, "wamid.ABC");
  assert.equal(entry.occurredAt, at);
  assert.equal(entry.subject, null);
  assert.match(entry.body, /\[Attachments: Q-1026\.pdf\]$/);
});

test("the failure summary says plainly that it was not delivered", () => {
  const s = outboundFailureSummary({ channel: "email", to: "a@b.co", subject: "Hello", text: "x" }, { contactId: "c1", label: "Signed document copy" }, "SMTP is not configured");
  assert.match(s, /^NOT DELIVERED: Signed document copy “Hello” to a@b\.co — SMTP is not configured$/);
});

// ── The shared send functions record only after the provider accepted ─────────

test("sendEmail records on success and a failure on both failure paths", () => {
  const s = src("src/lib/email.ts");
  const ok = s.indexOf("await noteSmtpOutcome(config, null);");
  const rec = s.indexOf("recordOutboundMessage(", ok);
  assert.ok(ok > 0 && rec > ok, "success record comes after SMTP accepted");
  assert.ok(rec < s.indexOf("return { ok: true", ok), "and before returning ok");
  assert.equal((s.match(/recordOutboundFailure\(logged, input\.record/g) ?? []).length, 2, "not-configured and transport failure");
  assert.match(s, /messageId: info\?\.messageId/);
});

test("sendSms records only on an accepted send", () => {
  assert.match(
    src("src/lib/sms.ts"),
    /if \(result\.ok\) await recordOutboundMessage\(\{ \.\.\.logged, messageId: result\.messageId \}, record\);\n\s+else await recordOutboundFailure\(logged, record, result\.error\);/,
  );
});

test("sendWhatsAppText records only after Meta accepted, failures on both failure paths", () => {
  const s = src("src/lib/whatsapp.ts");
  const start = s.indexOf("export async function sendWhatsAppText(");
  const body = s.slice(start, s.indexOf("\n}\n", start));
  // postWhatsAppMessage returns a thrown transport error and a non-2xx alike as
  // { ok: false } (#697), so one failure record covers both.
  const ok = body.indexOf("if (sent.ok) {");
  assert.ok(ok > 0 && body.indexOf("recordOutboundMessage(", ok) > ok);
  assert.equal(body.indexOf("recordOutboundMessage("), body.indexOf("recordOutboundMessage(", ok), "only one success record");
  assert.match(body, /recordOutboundMessage\(\{ \.\.\.logged, messageId: sent\.providerMessageId \?\? null \}, record\)/);
  assert.equal((body.match(/recordOutboundFailure\(logged, record/g) ?? []).length, 2, "not configured; transport or non-2xx");
});

// ── Every previously-silent customer send now passes a record ────────────────

const SILENT_PATHS: Array<[string, RegExp[]]> = [
  // Signing invitation + reminder (email and WhatsApp), link token as a secret.
  ["src/lib/signing/dispatch.ts", [/signingRecord\(r\.requestId, \{[\s\S]*?secrets: \[raw\]/, /html: email\.html,\n\s+record,/, /sendWhatsAppText\([^;]*, record\);/]],
  // Signer OTP by email or SMS, the code as a secret.
  ["src/lib/signing/identity.ts", [/label: "Signing verification code",\n\s+secrets: \[code\]/, /signingEmailContent\("otp", \{[\s\S]*?\}\)\),\n\s+record,/, /expires in 10 minutes\.`,\n\s+record,/]],
  // Sealed-PDF copies — live completion, recovery sweep and durable job.
  ["src/lib/signing/completionFanout.ts", [/record: await signingRecord\(opts\.requestId/]],
  ["src/lib/signing/jobWorker.ts", [/record: await signingRecord\(request\.id/]],
  ["src/lib/signing/complete.ts", [/deliverCompletionEmails\(\{\n\s+requestId: req\.id,/]],
  ["src/lib/signing/recoverCompletions.ts", [/deliverCompletionEmails\(\{\n\s+requestId: req\.id,/]],
  // Public OTPs.
  ["src/app/api/service-lookup/route.ts", [/secrets: \[code\]/, /tenantSmsContent\("lookup_code_sms", auth\.tenantId, vars\), record\)/, /html: message\.html, record \}\)/]],
  ["src/app/actions/portal.ts", [/record: \{ contactId: contact\.id, label: "Portal login code", secrets: \[code\] \}/]],
  // Helpdesk auto-reply, campaigns, survey distribution.
  ["src/lib/imapSync.ts", [/record: \{ contactId: outcome\.contactId/]],
  ["src/lib/campaigns.ts", [/headers: unsubscribeHeaders\(r\.token, brand\),\n\s+record,/, /renderTemplate\(campaign\.body, vars\), record\)/]],
  ["src/lib/marketingCampaignQueue.ts", [/headers: unsubscribeHeaders\(recipient\.token, brand\),\n\s+record,/, /renderTemplate\(recipient\.body, vars\), record\)/]],
  // Invitation and reminder: both from the editable templates, both recorded.
  ["src/lib/surveyDistributionQueue.ts", [/const message = await surveyMessage\(invite, requested === "email" \? "email" : "sms", false\);[\s\S]{0,400}subject: message\.subject, text: message\.text, html: message\.html, record \}/, /const message = await surveyMessage\(invite, requested === "email" \? "email" : "sms", true\);[\s\S]{0,400}subject: message\.subject, text: message\.text, html: message\.html, record \}/]],
];

for (const [file, patterns] of SILENT_PATHS) {
  test(`${file} records its customer sends`, () => {
    const s = src(file);
    for (const re of patterns) assert.match(s, re);
  });
}

test("no signing failure string carries the recipient's address into logs", () => {
  assert.doesNotMatch(src("src/lib/signing/completionFanout.ts"), /\$\{recipient\.email\}/);
  assert.doesNotMatch(src("src/lib/signing/jobWorker.ts"), /did not accept \$\{recipient\.email\}/);
});
