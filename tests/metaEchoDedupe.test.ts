import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { decideEcho, metaEchoDedupeKey } from "../src/lib/metaEcho";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const shipped = (rel: string) => stripComments(src(rel));

/**
 * Meta echoes every message the Page sends back to the webhook, including the
 * ones we sent. Recording each echo unconditionally wrote a second outbound row
 * for a message already in history, so one exchange showed up twice.
 *
 * The echo of OUR send is told apart by the id Meta returned when it accepted
 * it. We learn that id from the response to our own send, and Meta dispatches
 * the echo the moment it accepts, so the echo can be handled BEFORE the worker
 * commits the id — one database round trip of ambiguity.
 *
 * Nothing is guessed in that window. Every echo the ledger cannot already claim
 * is RECORDED, carrying its provider id, and the duplicate is reconciled away
 * afterwards by whichever side commits second.
 */

const TENANT = "tenant_denago_cpt";

test("an echo whose id the ledger already holds is dropped, not written", () => {
  const decision = decideEcho({ tenantId: TENANT, providerMessageId: "mid.1", ledgerHasId: true });
  assert.equal(decision.action, "drop");
  assert.equal(decision.reason, "already-in-ledger");
});

test("an echo the ledger cannot claim is recorded, keyed by its provider id", () => {
  const decision = decideEcho({ tenantId: TENANT, providerMessageId: "mid.colleague", ledgerHasId: false });
  assert.equal(decision.action, "record");
  assert.equal(decision.dedupeKey, metaEchoDedupeKey(TENANT, "mid.colleague"));
});

/**
 * THE CASE THAT MADE THE PREVIOUS DESIGN UNSOUND.
 *
 * The fallback compared the echo's TEXT against in-flight rows and dropped a
 * match. So a colleague sending "Thanks" from Business Suite while the CRM
 * happened to be sending "Thanks" lost their message permanently — and canned
 * replies ("Thanks", "Perfect", "Yes") are exactly the ones staff send by hand
 * and exactly the ones that collide. Missing history is worse than a duplicate,
 * because nobody can see that it is missing.
 */

test("a colleague's identical text is RECORDED, not absorbed by our in-flight send", () => {
  // We are sending "Thanks" right now; the id is not committed yet. Their echo
  // arrives with an id of its own. There is nothing here to compare text with,
  // by construction — the decision cannot see the message body at all.
  const decision = decideEcho({ tenantId: TENANT, providerMessageId: "mid.theirs", ledgerHasId: false });
  assert.equal(decision.action, "record", "a colleague's reply must survive whatever we are sending");
  assert.equal(decision.dedupeKey, metaEchoDedupeKey(TENANT, "mid.theirs"));
});

test("the decision never sees message content, so it cannot be lost to a coincidence", () => {
  const shape = shipped("src/lib/metaEcho.ts");
  assert.doesNotMatch(shape, /outboundTextOf/, "the text comparison is gone, not merely narrowed");
  assert.doesNotMatch(shape, /inFlight/, "and so is the in-flight content scan");
  // decideEcho's whole input, so a future edit cannot quietly reintroduce a body.
  const fn = shape.slice(shape.indexOf("export function decideEcho"), shape.indexOf("}", shape.indexOf("return {\n    action: \"record\",")));
  assert.doesNotMatch(fn, /text/, "no message body may reach this decision");
});

test("an echo with no provider id is recorded and kept", () => {
  // It cannot be correlated in either direction, so it can never be reconciled.
  // Keeping it is the same trade taken deliberately: a duplicate is visible and
  // survivable, a silently discarded customer-facing message is neither.
  const decision = decideEcho({ tenantId: TENANT, providerMessageId: null, ledgerHasId: false });
  assert.equal(decision.action, "record");
  assert.equal(decision.dedupeKey, null);
  assert.equal(decision.reason, "uncorrelatable");
});

test("the dedupe key is tenant-scoped, because the constraint is global", () => {
  // Communication.dedupeKey is unique across the whole table. Two tenants must
  // never collide on it, whatever a provider does with its ids.
  assert.notEqual(metaEchoDedupeKey("tenant_a", "mid.1"), metaEchoDedupeKey("tenant_b", "mid.1"));
  assert.match(metaEchoDedupeKey("tenant_a", "mid.1"), /^meta-echo:tenant_a:mid\.1$/);
});

/**
 * THE TWO CLEANUPS. Either side may commit second, so both do the same removal.
 */

test("the webhook re-reads the ledger after writing, and removes its own row", () => {
  const messenger = src("src/lib/messenger.ts");
  const fn = messenger.slice(messenger.indexOf("export async function recordDmEcho"));
  // Written first — the row exists even if this process dies before the recheck.
  const write = fn.indexOf("prisma.communication.upsert");
  const recheck = fn.indexOf("if (await ledgerHoldsProviderId(tenantId, providerMessageId))");
  assert.ok(write > 0 && recheck > write, "the re-check must come after the write, not instead of it");
  assert.match(fn.slice(recheck), /prisma\.communication\.deleteMany\(\{ where: \{ id: written\.id \} \}\)/);
  // And the row it deletes is the one it just wrote — never a lookalike.
  assert.doesNotMatch(fn.slice(recheck), /body:|text/, "the cleanup addresses one id, not a resemblance");
});

test("the worker removes the echo only after the id is committed", () => {
  const outbox = shipped("src/lib/botOutbox.ts");
  assert.match(outbox, /async function reconcileProviderEcho\(/);
  assert.match(outbox, /deleteMany\(\{ where: \{ dedupeKey: metaEchoDedupeKey\(tenantId, providerMessageId\) \} \}\)/);

  // BOTH sent paths reconcile, and both do it AFTER their own id write. The
  // superseded-lease path commits the id in a second statement, so reconciling
  // before it would look while the webhook could still legitimately record one.
  const deliver = outbox.slice(outbox.indexOf("async function deliverClaimed"));
  const body = deliver.slice(0, deliver.indexOf('\n  return "sent";\n}') + 20);
  const idWrites = [...body.matchAll(/providerMessageId: result\.providerMessageId \?\? null/g)].map((m) => m.index!);
  const reconciles = [...body.matchAll(/await reconcileProviderEcho\(/g)].map((m) => m.index!);
  assert.equal(idWrites.length, 2, "both sent paths must record the id");
  assert.equal(reconciles.length, 2, "and both must reconcile");
  assert.ok(reconciles[0] > idWrites[1], "the superseded-lease reconcile follows its own id write");
  assert.ok(reconciles[1] > idWrites[0], "and the ordinary one follows its own");
});

test("a failed delivery reconciles nothing", () => {
  // There is no proof of ownership without an accepted send, so an echo must not
  // be removed on the strength of an attempt.
  const outbox = shipped("src/lib/botOutbox.ts");
  const fail = outbox.slice(outbox.indexOf("async function failDelivery"), outbox.indexOf("async function reconcileProviderEcho"));
  assert.doesNotMatch(fail, /reconcileProviderEcho/);
});

/**
 * EVERY Meta send must keep the id, not just the plain-text one.
 *
 * The senders were three functions posting to the same endpoint and each parsing
 * its own response, and only the text one was taught to keep `message_id`. So a
 * plain reply could be recognised as our own echo and the identical text sent
 * with quick-reply chips could not — for no reason a reader could see. One call
 * site now, so it is not something a future sender can forget.
 */

test("every Meta send goes through one call site that keeps the provider id", () => {
  const messenger = shipped("src/lib/messenger.ts");
  assert.match(messenger, /async function postToSendApi\(/);
  assert.match(messenger, /providerMessageId: typeof accepted\?\.message_id === "string"/);
  for (const sender of ["sendDirectMessage", "sendDirectQuickReplies", "sendDirectAttachment"]) {
    const start = messenger.indexOf(`export async function ${sender}(`);
    assert.ok(start > 0, `${sender} must exist`);
    const body = messenger.slice(start, messenger.indexOf("\n}", start));
    assert.match(body, /MetaSendResult/, `${sender} must be able to return the id`);
    assert.match(body, /postToSendApi\(/, `${sender} must not parse its own response`);
    assert.doesNotMatch(body, /await fetch\(/, `${sender} must not have a second, forgettable call site`);
  }
});

test("the ledger stores the id on BOTH paths that mark a row sent", () => {
  const outbox = shipped("src/lib/botOutbox.ts");
  const writes = [...outbox.matchAll(/status: "sent", sentAt: new Date\(\)[^}]*/g)].map((m) => m[0]);
  assert.ok(writes.length >= 2, `expected the normal and superseded-lease paths, found ${writes.length}`);
  for (const write of writes) {
    // The superseded-lease path is the one that was missed: a message that WAS
    // delivered, recorded without its id, and therefore duplicated when its echo
    // arrived — with nothing able to reconcile it away afterwards.
    assert.match(write, /providerMessageId: result\.providerMessageId \?\? null/);
  }
  const schema = src("prisma/bot-outbox.prisma");
  assert.match(schema, /providerMessageId String\?/);
  assert.match(schema, /@@index\(\[tenantId, providerMessageId\]\)/);
});

test("the webhook hands the echo its provider id", () => {
  const route = shipped("src/app/api/webhooks/meta/route.ts");
  assert.match(route, /recordDmEcho\(platform, String\(ev\.recipient\?\.id \?\? ""\), text, ev\.message\?\.mid/);
});

test("the echo lookups are tenant-scoped", () => {
  // Without this one tenant's send suppresses another tenant's echo — the two
  // Pages are different businesses replying to different customers.
  const messenger = src("src/lib/messenger.ts");
  assert.match(messenger, /async function ledgerHoldsProviderId\(tenantId: string, providerMessageId: string\)/);
  const lookup = messenger.slice(messenger.indexOf("async function ledgerHoldsProviderId"));
  assert.match(lookup.slice(0, 400), /where: \{ tenantId, providerMessageId \}/);
  const fn = messenger.slice(
    messenger.indexOf("export async function recordDmEcho"),
    messenger.indexOf("export async function recordDmEcho") + 900,
  );
  assert.match(fn, /const tenantId = writeTenantId\(\) \?\? DEFAULT_TENANT_ID;/);
});

test("the echo row carries the provider id on the timeline too", () => {
  // Not only in the dedupe key: the id is the thing that correlates this row to
  // a receipt or a failure later, and a key is not a queryable identity.
  const messenger = shipped("src/lib/messenger.ts");
  const fn = messenger.slice(messenger.indexOf("export async function recordDmEcho"));
  assert.match(fn, /messageId: providerMessageId \?\? null/);
  // Upserted on the dedupe key, so Meta redelivering the webhook is a no-op
  // rather than a third copy.
  assert.match(fn, /where: \{ dedupeKey: decision\.dedupeKey \}/);
});
