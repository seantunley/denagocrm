import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * "Send test notification" reported "No subscribed devices yet — enable
 * notifications first" on a screen whose own button read "Disable on this
 * device". Two devices were in the table at the time, and the tenant join
 * returned both.
 *
 * Two defects, and the second is why the first was invisible:
 *
 *   1. A Server Action does not inherit the tenant scope a page render
 *      establishes, so `pushRecipientsForCurrentScope()` found the scope CLOSED
 *      and correctly returned nobody. Same shape as #520.
 *   2. `sendPushToAll` returns a bare count, so a closed scope, missing VAPID
 *      keys, a rejected send and a genuinely empty table all arrive as `0` — and
 *      the one sentence written for the last of them was shown for all four.
 *
 * Source-patterned, and says so: the scope behaviour itself needs a request.
 */

const action = src("src/app/actions/push.ts");
const lib = src("src/lib/push.ts");

test("the test push binds a tenant scope, because a Server Action has none", () => {
  // `withActingStaffScope` binds an ENCLOSING frame via runInTenantScope. An
  // enterWith-style call inside the callee does not reach the caller — the
  // lesson from the research-action failure, written down in the same week.
  assert.ok(action.includes("withActingStaffScope"), "sendTestPush must establish a scope");
  const sendTest = action.slice(action.indexOf("export async function sendTestPush("));
  assert.match(
    sendTest,
    /return withActingStaffScope\(/,
    "the scope must WRAP the body, not be entered inside it",
  );
});

test("a scopeless push is logged rather than dropped in silence", () => {
  // Returning [] is correct — a push with no workspace must go to nobody, never
  // to everybody. The defect was that it went nowhere and said nothing, so a
  // wiring fault at one entry point was indistinguishable from a workspace that
  // had never enabled notifications.
  const closed = lib.slice(lib.indexOf('if (s.mode === "closed")'), lib.indexOf('if (s.mode === "global")'));
  assert.ok(closed.includes("logError"), "a dropped push must be recorded");
  assert.ok(closed.includes("return []"), "and it must still fail closed");
  // logError raises a push of its own for the first error in a 30-minute window,
  // which would arrive back here in the same scopeless state.
  assert.ok(closed.includes("alert: false"), "the log must not recurse through the alerting push");
});

test("the four zero-send causes are reported as four different sentences", () => {
  const sendTest = action.slice(action.indexOf("export async function sendTestPush("));
  // Missing keys: nothing the person can fix from that screen, and nothing to do
  // with subscriptions.
  assert.match(sendTest, /VAPID keys are missing/);
  // Genuinely nobody subscribed — the only case the original sentence described.
  assert.match(sendTest, /No subscribed devices for this workspace/);
  // Devices found, every send rejected. The original wording told the owner to
  // enable notifications they had already enabled.
  assert.match(sendTest, /rejected every one/);
  // Partial delivery is a success with a caveat, not a failure.
  assert.match(sendTest, /the rest were unreachable/);
});

test("the count is measured before sending, so 'nobody' and 'failed' stay distinct", () => {
  const sendTest = action.slice(action.indexOf("export async function sendTestPush("));
  const resolved = sendTest.indexOf("pushRecipientsForCurrentScope(");
  const sent = sendTest.indexOf("sendPushToAll(");
  assert.ok(resolved >= 0 && sent >= 0, "both calls must be present");
  assert.ok(resolved < sent, "the recipients must be counted before the send, not inferred from it");
});

test("the fire-and-forget senders keep the cheap single count", () => {
  // The diagnosis is for the one caller that reports back to a person. Making
  // every push path resolve recipients twice would be a real cost for no benefit
  // — nothing else displays the difference.
  const code = shipped("src/lib/push.ts");
  assert.match(code, /export async function sendPushToAll\([\s\S]*?\): Promise<number>/);
});

test("subscribing still needs no scope, because PushSubscription is a global model", () => {
  // Worth pinning: the save path was NOT broken — a row was written today — and
  // that is only true because PushSubscription is in GLOBAL_MODELS, so the guard
  // does not demand a scope for it. If it ever leaves that list, subscribing
  // breaks the same way sending did, and this test is where that shows up.
  const guard = src("src/lib/tenantGuard.ts");
  const globals = guard.slice(guard.indexOf("GLOBAL_MODELS"), guard.indexOf("export function isTenantScopedModel"));
  assert.ok(globals.includes('"PushSubscription"'), "PushSubscription must remain a global model");
});
