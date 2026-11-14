import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseSteps, planInstructions } from "../src/lib/crmAssistantPlan";

const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const one = (s: string) => parseSteps(s)?.[0] as { tool: string; args: Record<string, unknown> } | undefined;

test("signing: every kind of request, waiting by default, up to 60", () => {
  assert.deepEqual(one('{"tool":"signing","args":{}}'), { tool: "signing", args: {} });
  assert.deepEqual(one('{"tool":"signing","args":{"status":"viewed","customer":"Marcel","from":"2026-11-01T08:00","limit":500}}')?.args, { status: "viewed", customer: "Marcel", from: "2026-11-01", limit: 60 });
  assert.equal(one('{"tool":"signing","args":{"status":"signed"}}'), undefined, "an unknown status is refused");
  assert.equal(one('{"tool":"signing","args":{"token":"x"}}'), undefined, "strict: nothing else may be asked for");
  const plan = planInstructions({ today: "2026-11-14", userName: "Sean", stages: [], staff: [], activityTypes: [] });
  assert.match(plan, /- signing: .*EVERY SIGNING REQUEST, not only quotes: delivery notes, contracts/);
  assert.match(plan, /"who still has to sign their delivery note"/);
});

test("signing is held to the Signatures page's rule, and stricter for delivery notes", () => {
  const src = code("src/lib/assistantSigningLookup.ts");
  assert.match(src, /hasAnyPermission\(user, "signing\.view", "signing\.manage"\)/);
  assert.match(src, /accessibleSignatureRequestWhere\(user\)/);
  // ANDed with everything, never spread; the workspace named.
  assert.match(src, /const where = \{\s*tenantId,\s*deletedAt: null,\s*AND: \[\s*mine,\s*deliveryNotes,/);
  // A delivery note only with its quote — spelled as an OR so a request with no subject is never dropped.
  assert.match(src, /\{ OR: \[\{ subjectType: null \}, \{ subjectType: \{ not: DELIVERY_NOTE \} \}, \{ subjectId: \{ in: quoteIds \} \}\] \}/);
  // Never selected, so never shown: tokens, emails, phones, IPs, hashes, signature images.
  const selected = src.slice(src.indexOf("recipients: { where:"), src.indexOf("prisma.signatureRequest.count"));
  assert.doesNotMatch(selected, /token|email|phone|signerIp|signatureRef|Hash|PdfRef/);
  assert.doesNotMatch(src, /logError|console\./, "nothing logged");
  const runner = code("src/lib/crmAssistant.ts");
  assert.match(runner, /case "signing": return signingLookup\(user, step\.args\);/);
});
