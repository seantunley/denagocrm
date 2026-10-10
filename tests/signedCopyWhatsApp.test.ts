import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SIGNING_EMAILS, isTextTemplate, renderSms, validateSigningTemplate } from "../src/lib/signing/emailTemplates";
import { AUTOMATIONS } from "../src/lib/automationRegister";

/**
 * The signed copy on WhatsApp, for a signer with no email address.
 *
 * What the real senders do against a real database is in
 * scripts/test-signed-copy-whatsapp.ts. These pin the parts that are decisions
 * rather than behaviour: the wording is the workspace's to edit, the message is
 * declared where the owner can see and switch it, and a refusal by WhatsApp is
 * never a failed completion.
 */
const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
/** Code only — a rule that survives solely in a comment is not a rule. */
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const VARS = { recipient_name: "Jane Doe", first_name: "Jane", document_title: "Quote Q-1026", company_name: "Acme Carts", signing_link: "https://crm.example.co.za/signing/abc" };

test("the wording that goes with the PDF is an editable template, like every other customer message", () => {
  const def = SIGNING_EMAILS.completed_whatsapp;
  assert.equal(def.channel, "whatsapp");
  assert.ok(isTextTemplate(def));
  assert.equal(def.group, SIGNING_EMAILS.completed.group, "listed with the other signing messages in Settings → Email templates");
  assert.equal(new Set(Object.values(SIGNING_EMAILS).map((d) => d.settingKey)).size, Object.keys(SIGNING_EMAILS).length, "its saved copy has a key of its own");

  const text = renderSms("completed_whatsapp", null, VARS);
  assert.match(text, /Jane Doe/);
  assert.match(text, /Quote Q-1026/);
  assert.match(text, /Acme Carts/);
  assert.doesNotMatch(text, /\{\{|crm\.example/, "no unfilled placeholder, and no link — the document is attached, not linked");

  assert.equal(renderSms("completed_whatsapp", { subject: "", body: "Hi {{first_name}}, your signed {{document_title}} is attached." }, VARS), "Hi Jane, your signed Quote Q-1026 is attached.");
});

test("the signed-copy message cannot be given a signing link", () => {
  const def = SIGNING_EMAILS.completed_whatsapp;
  assert.equal(def.action, null, "nothing to act on: the request is finished");
  assert.ok(!def.fields.includes("signing_link") && !def.fields.includes("code"));
  assert.match(
    validateSigningTemplate("completed_whatsapp", "", "Sign again here {{signing_link}}") ?? "",
    /Unknown field: \{\{signing_link\}\}/,
    "a finished document's message must not carry a way back into it",
  );
  assert.equal(validateSigningTemplate("completed_whatsapp", "", def.body), null, "the default passes its own validation");
});

test("the owner can see that signed copies also go by WhatsApp, and when they will not arrive", () => {
  const entry = AUTOMATIONS.find((a) => a.key === "signed-copies");
  assert.ok(entry);
  assert.deepEqual(entry.messages, ["completed", "completed_whatsapp"]);
  assert.ok(entry.channels?.includes("WhatsApp") && entry.channels.includes("email"));
  assert.match(entry.does, /no email address/);
  assert.match(entry.does, /24 hours/, "the limit is WhatsApp's, and the description says so");
  assert.deepEqual(entry.setting, { key: "SIGNING_SIGNED_COPIES", defaultOn: true }, "one switch governs both: it is the same automatic message");
});

test("WhatsApp declining the copy is not a failed fan-out", () => {
  const fanout = code("src/lib/signing/completionFanout.ts");
  const branch = fanout.slice(fanout.indexOf("if (!recipient.email) {"), fanout.indexOf("if (recipient.completedEmailSentAt) {"));
  assert.ok(branch.length > 0, "the no-address branch exists");
  assert.match(branch, /if \(phone && !recipient\.completedEmailSentAt && \(await copyByWhatsApp\(opts, recipient, phone\)\)\) \{\s*sent \+= 1;\s*await recordDelivery\(recipient\.id\);\s*\}\s*continue;/);
  assert.doesNotMatch(branch, /failures\.push/, "a failure would withhold the completion marker and re-drive the fan-out for a message that cannot arrive");
  assert.match(fanout, /signingWhatsAppText\("completed_whatsapp",/);
  assert.match(fanout, /where: \{ \.\.\.opts\.tenantWhere, id: \{ in: unaddressed \}, phone: \{ not: null \} \}/, "numbers are read inside the named workspace only");
});

test("a signed contract goes to WhatsApp as an uploaded file, never as a link of ours", () => {
  const whatsapp = code("src/lib/whatsapp.ts");
  const send = whatsapp.slice(whatsapp.indexOf("export async function sendWhatsAppDocument("), whatsapp.indexOf("async function sendInteractive("));
  assert.match(send, /await uploadWhatsAppMedia\(file\.content, file\.contentType \?\? "application\/pdf", file\.filename\)/);
  assert.match(send, /type: "document",\s*document: \{ id: media\.id, filename: file\.filename/);
  assert.doesNotMatch(send, /link:|shareableFileUrl/, "no address of ours that anyone holding it could open");
  assert.match(send, /if \(record\) await recordOutboundFailure\(logged, record, error\);/, "a refusal reaches the customer's record");
  assert.match(send, /if \(record\) await recordOutboundMessage\(\{ \.\.\.logged, messageId: sent\.providerMessageId \?\? null \}, record\);/, "…and so does a send, with the id a later failure is matched on");
});
