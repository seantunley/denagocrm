import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { allowedPushHosts, isAllowedPushEndpoint } from "../src/lib/pushEndpoint";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * A Web Push subscription endpoint arrives from the BROWSER and was stored
 * verbatim — savePushSubscription took `sub.endpoint` off a server-action
 * argument and upserted it. Anything an authenticated user could type became a
 * URL the server would later POST to, and sendPushToAll fires those requests on
 * ordinary app events (a new ticket, a booking, an inbound email), so the
 * attacker did not even have to trigger them.
 *
 * With a response oracle: sendTestPush returns how many endpoints accepted, so a
 * subscription pointed at http://127.0.0.1:5432/ answers "is this reachable from
 * inside your network", one guess at a time.
 */

test("the loopback and metadata endpoints an SSRF actually aims at are refused", () => {
  for (const endpoint of [
    "http://127.0.0.1:5432/",
    "http://localhost/admin",
    "https://localhost/admin",
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://[::1]:8080/",
    "http://10.0.0.5/internal",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "file:///etc/passwd",
    "gopher://127.0.0.1:6379/_INFO",
    "http://fcm.googleapis.com/fcm/send/abc", // http, not https
    "https://fcm.googleapis.com.evil.example/fcm/send/abc",
    "https://evil.example/fcm.googleapis.com",
    "https://notpush.apple.com/x",
    "https://user:pass@fcm.googleapis.com/fcm/send/abc",
    "not a url",
    "",
  ]) {
    assert.equal(isAllowedPushEndpoint(endpoint), false, `${endpoint} must be refused`);
  }
});

test("the real push services still work", () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/eR8x…",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAA…",
    "https://web.push.apple.com/QMHmZ…",
    "https://db5p.notify.windows.com/w/?token=Bc…",
  ]) {
    assert.equal(isAllowedPushEndpoint(endpoint), true, `${endpoint} is a genuine push service`);
  }
});

test("a suffix entry cannot be satisfied by a lookalike host", () => {
  // `.push.apple.com` must match `web.push.apple.com` and never
  // `notpush.apple.com` — the leading dot is what makes that true.
  assert.ok(allowedPushHosts().includes(".push.apple.com"));
  assert.equal(isAllowedPushEndpoint("https://web.push.apple.com/x"), true);
  assert.equal(isAllowedPushEndpoint("https://notpush.apple.com/x"), false);
  assert.equal(isAllowedPushEndpoint("https://push.apple.com.evil.example/x"), false);
});

test("the operator escape hatch works, and is still a host check", () => {
  const before = process.env.PUSH_ENDPOINT_HOSTS;
  try {
    process.env.PUSH_ENDPOINT_HOSTS = "push.example.co.za, .push.regional.example";
    assert.equal(isAllowedPushEndpoint("https://push.example.co.za/send/1"), true);
    assert.equal(isAllowedPushEndpoint("https://eu.push.regional.example/send/1"), true);
    // …and it does not become a way to allow anything
    assert.equal(isAllowedPushEndpoint("http://push.example.co.za/send/1"), false, "still https-only");
    assert.equal(isAllowedPushEndpoint("https://push.example.co.za.evil.example/"), false);
  } finally {
    if (before === undefined) delete process.env.PUSH_ENDPOINT_HOSTS;
    else process.env.PUSH_ENDPOINT_HOSTS = before;
  }
});

test("the endpoint is refused at the write AND at the send", () => {
  // At the write so a bad endpoint never reaches the database; at the send
  // because that is the line that makes the request, and rows stored before this
  // guard existed are still in the table.
  assert.match(
    shipped("src/app/actions/push.ts"),
    /if \(!isAllowedPushEndpoint\(sub\.endpoint\)\) \{\s*throw/,
    "savePushSubscription must refuse before it upserts",
  );
  const send = shipped("src/lib/push.ts");
  assert.match(send, /if \(!isAllowedPushEndpoint\(sub\.endpoint\)\)/, "and the send loop must re-check");
  const guardAt = send.indexOf("isAllowedPushEndpoint(sub.endpoint)");
  const sendAt = send.indexOf("webpush.sendNotification");
  assert.ok(guardAt !== -1 && sendAt !== -1 && guardAt < sendAt, "the check must precede the request");
});

test("a push cannot hang the caller", () => {
  // web-push passes `timeout` through to the HTTP request; without it the
  // request inherits Node's default, which is no timeout — and sendPushToAll is
  // awaited inside cron and action paths that have their own deadlines.
  const code = shipped("src/lib/push.ts");
  assert.match(code, /const PUSH_TIMEOUT_MS = \d/);
  assert.match(code, /\{ timeout: PUSH_TIMEOUT_MS \}/, "the timeout must be passed to sendNotification");
});
