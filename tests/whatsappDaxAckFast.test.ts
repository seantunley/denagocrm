import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Sean, 2026-11-02: every DAX question from a staff phone arrived two or three times ("leased — asking the provider
// to redeliver"), because the answer ran inside the webhook and Meta re-sends anything not acknowledged in seconds.
const route = readFileSync("src/app/api/webhooks/whatsapp/route.ts", "utf8");

test("a batch from a linked staff phone is acknowledged at once and answered after, in its own channel scope", () => {
  const at = route.indexOf("if (messages.length && (await isLinkedStaffPhone(");
  assert.ok(at > 0);
  const block = route.slice(at, route.indexOf("await processMessages();", at));
  assert.match(block, /after\(\(\) =>\s*withChannelTenantScope\("whatsapp", phoneNumberId, processMessages, \(\) => undefined\)\.catch\(/);
  assert.match(block, /return;/);
});

test("every other batch — a customer's — still runs inside the request, so Meta's redelivery stays the safety net", () => {
  const deferred = route.indexOf("if (messages.length && (await isLinkedStaffPhone(");
  const inline = route.indexOf("await processMessages();", deferred);
  assert.ok(inline > deferred, "the in-request run follows the staff branch");
  // The claim, the lease answer and the retry on failure are untouched inside processMessages.
  const run = route.slice(route.indexOf("const processMessages = async () => {"), deferred);
  for (const step of ["claimInboundBotEvent(", 'outcome.status === "leased"', "completeInboundBotEvent(claim)", "retryInboundBotEvent(claim, error)"]) {
    assert.ok(run.includes(step), step);
  }
});

test("the staff check is cheap and answers nothing: a verified link in THIS workspace, with DAX on WhatsApp on", () => {
  const lib = readFileSync("src/lib/assistantWhatsApp.ts", "utf8");
  const fn = lib.slice(lib.indexOf("export async function isLinkedStaffPhone"), lib.indexOf("export async function handleStaffWhatsApp"));
  assert.match(fn, /if \(!scope \|\| scope\.system \|\| !scope\.tenantId\) return false;/);
  assert.match(fn, /assistantWhatsAppOn\(\)/);
  assert.match(fn, /where: \{ tenantId: scope\.tenantId, waId, verifiedAt: \{ not: null \} \}/);
  assert.doesNotMatch(fn, /sendPlan|askCrm|logAudit|update/);
});
