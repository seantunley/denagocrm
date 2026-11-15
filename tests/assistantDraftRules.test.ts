import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { draftTarget, draftsBlock, draftsToKeep, parseStoredDrafts, DRAFT_RULE, type StoredDraft } from "../src/lib/assistantDraftRules";
import { proposedAction } from "../src/lib/assistantActions";

const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// DAX_Conversational_Upgrades §1: an email longer than 400 characters, a delivery promise in its closing paragraph.
const CLOSING = "We will deliver the Rover XL to your Cape Town address on Friday 21 November, before noon.";
const email: StoredDraft = {
  leadId: "lead_angelique", leadLabel: "Angelique Botha", channel: "email", subject: "Your Rover XL quotation",
  body: `Dear Angelique,\n\n${"Thank you for your time on the phone today. Attached is the quotation for the Rover XL in Sable Grey, with the charging kit and the two-year service plan we discussed. ".repeat(3)}\n\n${CLOSING}\n\nKind regards,\nSean`,
  cc: ["ivan@denago.test"],
};
const whatsapp: StoredDraft = { leadId: "lead_angelique", leadLabel: "Angelique Botha", channel: "whatsapp", body: "Hi Angelique, the Rover XL quote is in your inbox — delivery Friday 21 Nov before noon." };

test("a turn keeps its drafts word for word — and only drafts", () => {
  const kept = draftsToKeep([
    { kind: "draft_message", leadId: "l1", leadLabel: "A", channel: "email", subject: "S", body: "B", cc: ["x@y.test"] },
    { kind: "draft_message", leadId: "l1", leadLabel: "A", channel: "whatsapp", body: "W", cc: ["x@y.test"] },
    { kind: "note", leadId: "l1", body: "not a draft" },
  ]);
  assert.deepEqual(kept, [
    { leadId: "l1", leadLabel: "A", channel: "email", subject: "S", body: "B", cc: ["x@y.test"] },
    { leadId: "l1", leadLabel: "A", channel: "whatsapp", body: "W" },
  ], "a WhatsApp has no Cc; a note is no draft");
  assert.deepEqual(parseStoredDrafts([{ leadId: "l1", channel: "sms", body: "x" }, "junk", null, { body: 3 }]), [], "anything not shaped like a draft is dropped");
});

test("which draft a question means", () => {
  const drafts = [email, whatsapp];
  assert.equal(draftTarget("change only the greeting", drafts), 1, "the latest by default");
  assert.equal(draftTarget("change the first paragraph", drafts), 1, "'first paragraph' is not the first version");
  assert.equal(draftTarget("go back to the first version", drafts), 0);
  assert.equal(draftTarget("use the original", drafts), 0);
  assert.equal(draftTarget("draft 1 was better — use that", drafts), 0);
  assert.equal(draftTarget("the previous version please", drafts), 0);
  assert.equal(draftTarget("add the Golf Caddie to the email", drafts), 0, "the latest of the kind named");
  assert.equal(draftTarget("turn that into a WhatsApp", [email]), 0, "a change of kind means the latest draft");
  assert.equal(draftTarget("turn that into a WhatsApp", [whatsapp, email]), 1, "…not the latest WhatsApp");
  assert.equal(draftTarget("anything", []), -1);
});

test("the draft the question means is given IN FULL — recipient, subject, Cc and its closing promise", () => {
  assert.ok(email.body.length > 400);
  const block = draftsBlock([email], "change only the greeting");
  assert.ok(block.includes(email.body), "the whole body, not 400 characters of it");
  assert.ok(block.includes(CLOSING));
  assert.match(block, /Cc: ivan@denago\.test/);
  assert.match(block, /Subject: Your Rover XL quotation/);
  assert.match(block, /leadId lead_angelique/);
});

test("after a WhatsApp variant the email is still there, with its Cc; only the one meant is in full", () => {
  const block = draftsBlock([email, whatsapp], "make the WhatsApp warmer");
  assert.match(block, /Draft 1 — Email to Angelique Botha \(leadId lead_angelique\), subject "Your Rover XL quotation", cc ivan@denago\.test/);
  assert.ok(block.includes(whatsapp.body), "the WhatsApp in full");
  assert.ok(!block.includes(CLOSING), "the email only as one line");
  const back = draftsBlock([email, whatsapp], "now change the email's sign-off");
  assert.ok(back.includes(email.body) && /Cc: ivan@denago\.test/.test(back), "the email in full again, Cc and all");
});

test("the rule: change only what was asked, same deal and Cc; a WhatsApp variant leaves the email as it is", () => {
  assert.match(DRAFT_RULE, /keep every other sentence word for word, with the same leadId, subject and cc/);
  assert.match(DRAFT_RULE, /the earlier draft stays as it is/);
  assert.match(DRAFT_RULE, /never copied into a message for another customer/);
});

test("a draft may carry a Cc — real addresses, at most five; a WhatsApp's is dropped at the card", () => {
  const draft = (cc: unknown) => proposedAction.safeParse({ type: "draft_message", leadId: "lead_angelique", channel: "email", subject: "S", body: "B", cc }).success;
  assert.equal(draft(["ivan@denago.test"]), true);
  assert.equal(draft(["not an address"]), false);
  assert.equal(draft(Array.from({ length: 6 }, (_, i) => `p${i}@x.test`)), false, "at most five");
  assert.match(code("src/lib/crmAssistant.ts"), /\.\.\.\(p\.channel === "email" && p\.cc\?\.length \? \{ cc: p\.cc \} : \{\}\),/);
  // Sent through the composer, which checks every address again.
  assert.match(code("src/app/actions/assistant.ts"), /if \(cc\) form\.set\("cc", cc\);/);
});

test("DAX reads the conversation's drafts and keeps each answer's", () => {
  const src = code("src/lib/crmAssistant.ts");
  assert.match(src, /conversationDrafts\(who, thread\.id\)/);
  assert.match(src, /\.\.\.\(draftsToKeep\(actions\)\.length \? \{ drafts: draftsToKeep\(actions\) as object \} : \{\}\),/);
  // In BOTH prompts — the plan's (so an edit isn't researched from scratch) and the answer's.
  assert.equal((src.match(/listedEarlier,\n\s*draftsEarlier,/g) ?? []).length, 2);
  const loader = code("src/lib/assistantDrafts.ts");
  assert.match(loader, /where: \{ tenantId: who\.tenantId, userId: who\.userId, conversationId, drafts: \{ not: Prisma\.DbNull \} \}/);
});
