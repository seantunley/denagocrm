import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const action = src("src/app/actions/push.ts");
const lib = src("src/lib/push.ts");
const toggle = src("src/components/PushToggle.tsx");
const rootWorker = src("public/sw.js");
const messagesWorker = src("public/messages-sw.js");
const register = src("src/components/RegisterServiceWorker.tsx");
const messagesNav = src("src/components/MessagesNav.tsx");

test("the test push binds a tenant scope, because a Server Action has none", () => {
  assert.ok(action.includes("withActingStaffScope"), "sendTestPush must establish a scope");
  const sendTest = action.slice(action.indexOf("export async function sendTestPush("));
  assert.match(sendTest, /return withActingStaffScope\(/);
});

test("a scopeless push is logged rather than dropped in silence", () => {
  const closed = lib.slice(lib.indexOf('if (s.mode === "closed")'), lib.indexOf('if (s.mode === "global")'));
  assert.ok(closed.includes("logError"), "a dropped push must be recorded");
  assert.ok(closed.includes("return []"), "and it must still fail closed");
  assert.ok(closed.includes("alert: false"), "the log must not recurse through the alerting push");
});

test("the four zero-send causes are still distinguishable", () => {
  const sendTest = action.slice(action.indexOf("export async function sendTestPush("));
  assert.match(sendTest, /VAPID keys are missing/);
  assert.match(sendTest, /No subscribed devices for this workspace/);
  assert.match(sendTest, /push service rejected every one/);
  assert.match(sendTest, /the rest were unreachable/);
});

test("the count is measured before sending, so 'nobody' and 'failed' stay distinct", () => {
  const sendTest = action.slice(action.indexOf("export async function sendTestPush("));
  const resolved = sendTest.indexOf("pushRecipientsForCurrentScope(");
  const sent = sendTest.indexOf("sendPushToAll(");
  assert.ok(resolved >= 0 && sent >= 0);
  assert.ok(resolved < sent);
});

test("the fire-and-forget senders keep the cheap single count", () => {
  const code = shipped("src/lib/push.ts");
  assert.match(code, /export async function sendPushToAll\([\s\S]*?\): Promise<number>/);
});

test("subscribing still needs no scope, because PushSubscription is a global model", () => {
  const guard = src("src/lib/tenantGuard.ts");
  const globals = guard.slice(guard.indexOf("GLOBAL_MODELS"), guard.indexOf("export function isTenantScopedModel"));
  assert.ok(globals.includes('"PushSubscription"'));
});

test("Messages has its own service-worker registration and scope", () => {
  assert.match(register, /register\("\/messages-sw\.js"/);
  assert.match(register, /scope: "\/messages"/);
  assert.doesNotMatch(register, /scope: "\/messages\/"/);
  assert.match(register, /updateViaCache: "none"/);
  assert.match(toggle, /const MESSAGES_SW = "\/messages-sw\.js"/);
  assert.match(toggle, /mode === "messages"[\s\S]*?scope: "\/messages"/);
  assert.match(messagesWorker, /self\.addEventListener\("push"/);
  assert.match(messagesWorker, /messages-192\.png/);
});

test("Messages does not mistake the legacy root CRM subscription for enabled", () => {
  const initialise = toggle.slice(
    toggle.indexOf("async function initialise()"),
    toggle.indexOf("async function enable()"),
  );
  assert.match(initialise, /const reg = await registrationForMode\(mode\)/);
  assert.match(initialise, /const sub = await reg\.pushManager\.getSubscription\(\)/);
  assert.match(initialise, /const legacy = await rootSubscription\(\)/);
  assert.match(initialise, /setRepairNeeded\(true\)/);
  assert.match(initialise, /old shared CRM notification channel/);
});

test("repair saves the Messages subscription before deleting the legacy root subscription", () => {
  const repair = toggle.slice(
    toggle.indexOf("async function enable()"),
    toggle.indexOf("async function disable()"),
  );
  const save = repair.indexOf("syncPushSubscription(sub)");
  const remove = repair.indexOf("removeLegacyRootSubscription(sub.endpoint)");
  assert.ok(save >= 0 && remove > save, "the replacement must be durable before the old channel is removed");
});

test("the Messages test targets the exact subscription of the phone being tested", () => {
  const clientTest = toggle.slice(toggle.indexOf("async function test()"));
  assert.match(clientTest, /sendTestPush\(\{ mode, testId, endpoint: sub\.endpoint \}\)/);

  const serverTest = action.slice(action.indexOf("export async function sendTestPush("));
  assert.match(serverTest, /const targetEndpoint = options\.endpoint\?\.trim\(\)/);
  assert.match(serverTest, /devices\.some\(\(device\) => device\.endpoint === targetEndpoint\)/);
  assert.match(serverTest, /\{ endpoint: targetEndpoint \|\| undefined \}/);

  const sender = lib.slice(lib.indexOf("export async function sendPushToAll("));
  assert.match(sender, /endpoint\?: string \| null/);
  assert.match(sender, /recipients\.filter\(\(sub\) => sub\.endpoint === options\.endpoint\)/);
});

test("Messages refuses the old broadcast-style test rather than reporting another phone as success", () => {
  const sendTest = action.slice(action.indexOf("export async function sendTestPush("));
  assert.match(sendTest, /if \(messagesMode && !targetEndpoint\)/);
  assert.match(sendTest, /old notification test/);
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

test("provider acceptance is not presented as proof that this phone's worker received the push", () => {
  for (const worker of [rootWorker, messagesWorker]) {
    assert.match(worker, /push-test-displayed/);
    assert.match(worker, /push-test-failed/);
    assert.match(worker, /notifyOpenClients/);
  }
  assert.match(toggle, /navigator\.serviceWorker\.addEventListener\("message", onMessage\)/);
  assert.match(toggle, /Waiting for this device to confirm display/);
  assert.match(toggle, /worker never received it/);
});

test("the dedicated worker only acknowledges a test after showNotification resolves", () => {
  const pushHandler = messagesWorker.slice(
    messagesWorker.indexOf('self.addEventListener("push"'),
    messagesWorker.indexOf('self.addEventListener("notificationclick"'),
  );
  const display = pushHandler.indexOf("showNotification(");
  const success = pushHandler.indexOf('type: "push-test-displayed"');
  const failure = pushHandler.indexOf('type: "push-test-failed"');
  assert.ok(display >= 0 && success > display);
  assert.ok(failure > display);
});
