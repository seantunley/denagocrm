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
 * The original diagnosis fixed scope and zero-send reporting. The Messages PWA
 * exposed a second class of false-positive: a browser can retain a local
 * PushSubscription after its server row disappears, and a provider accepting a
 * push says nothing about whether THIS phone's worker actually displayed it.
 * The tests below pin both sides of that boundary.
 */

const action = src("src/app/actions/push.ts");
const lib = src("src/lib/push.ts");
const toggle = src("src/components/PushToggle.tsx");
const worker = src("public/sw.js");
const messagesNav = src("src/components/MessagesNav.tsx");

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

test("an existing browser subscription is re-synced to the server on panel open", () => {
  const initialise = toggle.slice(
    toggle.indexOf("async function initialise()"),
    toggle.indexOf("async function enable()"),
  );
  const local = initialise.indexOf("getSubscription()");
  const sync = initialise.indexOf("syncPushSubscription(sub)");
  assert.ok(local >= 0 && sync >= 0, "initialisation must inspect and sync an existing subscription");
  assert.ok(local < sync, "the browser subscription must be discovered before it is re-upserted");
  assert.match(initialise, /Notification\.permission === "granted"/);
});

test("the Messages PWA test follows the real social-DM kind and landing page", () => {
  const sendTest = action.slice(action.indexOf("export async function sendTestPush("));
  assert.match(sendTest, /const messagesMode = options\.mode === "messages"/);
  assert.match(sendTest, /getSetting\("PUSH_DISABLED_KINDS"\)/);
  assert.match(sendTest, /disabled\?\.includes\("dm"\)/);
  assert.match(sendTest, /const baseUrl = messagesMode \? "\/messages" : "\/"/);
  assert.match(sendTest, /const kind = messagesMode \? "dm" : undefined/);
  assert.match(messagesNav, /<PushToggle mode="messages" \/>/);
});

test("provider acceptance is not presented as proof that this phone displayed the notification", () => {
  assert.match(worker, /push-test-displayed/);
  assert.match(worker, /push-test-failed/);
  assert.match(worker, /notifyOpenClients/);
  assert.match(toggle, /navigator\.serviceWorker\.addEventListener\("message", onMessage\)/);
  assert.match(toggle, /Waiting for this device to confirm display/);
  assert.match(toggle, /This device did not confirm receipt/);
});

test("the service worker only acknowledges a test after showNotification resolves", () => {
  const pushHandler = worker.slice(
    worker.indexOf('self.addEventListener("push"'),
    worker.indexOf('self.addEventListener("notificationclick"'),
  );
  const display = pushHandler.indexOf("showNotification(");
  const success = pushHandler.indexOf('type: "push-test-displayed"');
  const failure = pushHandler.indexOf('type: "push-test-failed"');
  assert.ok(display >= 0 && success > display, "display acknowledgement must follow showNotification");
  assert.ok(failure > display, "display failures must be returned to the open test page");
});
