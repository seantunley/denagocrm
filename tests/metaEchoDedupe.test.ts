import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const shipped = (rel: string) => stripComments(src(rel));

/**
 * Meta echoes every message the Page sends back to the webhook, including the
 * ones we sent. Recording each echo unconditionally wrote a second outbound row
 * for a message the CRM had already logged, so one real customer message showed
 * up twice in the thread.
 *
 * The distinguishing fact is the provider's own id for the accepted send. An echo
 * carrying an id the delivery ledger already holds is our message coming back; an
 * echo without one is a colleague replying from the Facebook Page inbox, which is
 * a real event and must still be recorded.
 */

test("an accepted Meta send keeps the id the provider returned", () => {
  const messenger = shipped("src/lib/messenger.ts");
  const fn = messenger.slice(messenger.indexOf("export async function sendDirectMessage"));
  assert.match(fn.slice(0, 1400), /providerMessageId\?: string/, "the send result must be able to carry the id");
  assert.match(fn.slice(0, 2000), /accepted\?\.message_id/, "the accepted response must be read, not discarded");
});

test("the delivery ledger stores the id against the exact send", () => {
  const outbox = shipped("src/lib/botOutbox.ts");
  assert.match(
    outbox,
    /status: "sent"[^}]*providerMessageId: result\.providerMessageId \?\? null/,
    "the id must be written when the row is marked sent",
  );
  const schema = src("prisma/bot-outbox.prisma");
  assert.match(schema, /providerMessageId String\?/);
  assert.match(schema, /@@index\(\[tenantId, providerMessageId\]\)/);
});

test("an echo of our own send is not written to history again", () => {
  const messenger = shipped("src/lib/messenger.ts");
  const fn = messenger.slice(messenger.indexOf("export async function recordDmEcho"));
  assert.match(fn.slice(0, 900), /if \(providerMessageId\)/, "the check must be keyed on the provider id");
  assert.match(fn.slice(0, 900), /botFlowOutbox\.findFirst/);
  assert.match(fn.slice(0, 900), /if \(ours\) return;/, "our own echo must be dropped before it is recorded");
  // Scoped, or one tenant's send would suppress another tenant's echo.
  assert.match(fn.slice(0, 900), /tenantId: writeTenantId\(\) \?\? DEFAULT_TENANT_ID/);
});

test("an echo with no id is still recorded — it is a human on the Page", () => {
  const messenger = shipped("src/lib/messenger.ts");
  const fn = messenger.slice(messenger.indexOf("export async function recordDmEcho"));
  // The guard is conditional on having an id. Dropping every echo would lose
  // replies colleagues send from the Facebook Page inbox, which the CRM has no
  // other way of learning about.
  const guard = fn.slice(0, fn.indexOf("const idField"));
  assert.match(guard, /if \(providerMessageId\) \{/);
  assert.doesNotMatch(guard, /^\s*return;\s*$/m, "an unconditional return would drop genuine Page replies");
});

test("the webhook hands the echo its provider id", () => {
  const route = shipped("src/app/api/webhooks/meta/route.ts");
  assert.match(route, /recordDmEcho\(platform, String\(ev\.recipient\?\.id \?\? ""\), text, ev\.message\?\.mid/);
});
