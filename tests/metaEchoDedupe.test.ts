import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { decideEcho, outboundTextOf, ECHO_CONTENT_WINDOW_MS } from "../src/lib/metaEcho";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const shipped = (rel: string) => stripComments(src(rel));

/**
 * Meta echoes every message the Page sends back to the webhook, including the
 * ones we sent. Recording each echo unconditionally wrote a second outbound row
 * for a message the CRM had already logged, so one exchange showed up twice in
 * the thread.
 *
 * The decision is a pure function so these can exercise it rather than describe
 * it. The two source assertions at the bottom cover the wiring it cannot see.
 */

const text = (body: string) => ({ providerMessageId: null, payload: { type: "text", text: body } });

test("an echo bearing an id the ledger holds is ours", () => {
  const decision = decideEcho({ text: "On my way", providerMessageId: "mid.1", ledgerHasId: true, inFlight: [] });
  assert.equal(decision.ours, true);
  assert.equal(decision.reason, "provider-id");
});

test("an echo bearing an id the ledger does NOT hold is a colleague on the Page", () => {
  // This is the case that must survive. A colleague replying from the Facebook
  // Page inbox is a genuine event the CRM has no other way of learning about, so
  // dropping every echo would trade duplicate history for missing history.
  const decision = decideEcho({
    text: "Different reply",
    providerMessageId: "mid.someone-else",
    ledgerHasId: false,
    inFlight: [text("On my way")],
  });
  assert.equal(decision.ours, false);
});

/**
 * THE RACE. We learn Meta's id from the response to our OWN send, and Meta
 * dispatches the echo the moment it accepts. So the echo can arrive and be
 * processed before the worker has written that id to the row: the ledger holds
 * our message but not its id, the exact check misses, and the duplicate is
 * written anyway. The gap is one database round trip wide.
 */

test("an echo racing ahead of the id being recorded is still recognised", () => {
  const decision = decideEcho({
    text: "On my way",
    providerMessageId: "mid.1",
    ledgerHasId: false, // the worker has not written it yet
    inFlight: [text("On my way")],
  });
  assert.equal(decision.ours, true);
  assert.equal(decision.reason, "in-flight-content", "the content fallback is what closes the window");
});

test("an echo with no id at all is matched the same way", () => {
  // Meta does not always populate `mid`. Without the fallback these were every
  // send duplicated, since the id check had nothing to check.
  const decision = decideEcho({
    text: "On my way",
    providerMessageId: null,
    ledgerHasId: false,
    inFlight: [text("On my way")],
  });
  assert.equal(decision.ours, true);
});

test("a row that already carries an id cannot claim a different message's echo", () => {
  // The narrowing condition. Once a row has been reconciled, an echo with the
  // same text and a different id is a genuinely different message — a colleague
  // sending the same words — and must be recorded.
  const reconciled = { providerMessageId: "mid.ours", payload: { type: "text", text: "On my way" } };
  const decision = decideEcho({
    text: "On my way",
    providerMessageId: "mid.theirs",
    ledgerHasId: false,
    inFlight: [reconciled],
  });
  assert.equal(decision.ours, false, "an already-reconciled row must not absorb another echo");
});

test("different text on the same conversation is not absorbed", () => {
  const decision = decideEcho({
    text: "Actually, tomorrow",
    providerMessageId: null,
    ledgerHasId: false,
    inFlight: [text("On my way")],
  });
  assert.equal(decision.ours, false);
});

test("an empty echo body is never matched by content", () => {
  // Every text-less row would look like a match. Only the id can speak for those.
  const decision = decideEcho({
    text: "",
    providerMessageId: null,
    ledgerHasId: false,
    inFlight: [{ providerMessageId: null, payload: { type: "image", url: "https://x/y.jpg" } }],
  });
  assert.equal(decision.ours, false);
});

test("nothing in flight means nothing to claim", () => {
  const decision = decideEcho({ text: "On my way", providerMessageId: null, ledgerHasId: false, inFlight: [] });
  assert.equal(decision.ours, false);
  assert.equal(decision.reason, "not-ours");
});

test("the text of a payload is read the way the sender would have sent it", () => {
  assert.equal(outboundTextOf({ type: "text", text: "Hello" }), "Hello");
  // A choice message is text plus chips; the wire text is the text.
  assert.equal(outboundTextOf({ type: "choice", text: "Pick one", options: [] }), "Pick one");
  assert.equal(outboundTextOf({ type: "image", url: "https://x/y.jpg", caption: "The car" }), "The car");
  // A bare image has no text, and must not read as an empty-string match.
  assert.equal(outboundTextOf({ type: "image", url: "https://x/y.jpg" }), null);
  assert.equal(outboundTextOf({ type: "image", url: "https://x/y.jpg", caption: "" }), null);
  assert.equal(outboundTextOf(null), null);
  assert.equal(outboundTextOf("just a string"), null);
  assert.equal(outboundTextOf({ type: "attachment", url: "https://x/y.pdf" }), null);
});

test("the content window is short enough to be about the race, not about dedupe", () => {
  // Long enough to cover one HTTP response many times over; short enough that
  // yesterday's identical greeting is a new message.
  assert.ok(ECHO_CONTENT_WINDOW_MS >= 60_000, "must comfortably cover a slow provider response");
  assert.ok(ECHO_CONTENT_WINDOW_MS <= 60 * 60 * 1000, "an hour-wide net would suppress genuine repeats");
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
    // arrived.
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
  const fn = messenger.slice(
    messenger.indexOf("async function echoIsOurOwnSend"),
    messenger.indexOf("export async function recordDmEcho"),
  );
  assert.match(fn, /const tenantId = writeTenantId\(\) \?\? DEFAULT_TENANT_ID;/);
  const queries = [...fn.matchAll(/where: \{\s*\n?\s*tenantId,/g)];
  assert.equal(queries.length, 2, "both the id lookup and the in-flight lookup must be scoped");
});
