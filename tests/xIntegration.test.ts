import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import { normaliseXActivity, verifyXSignature, xCrcResponse } from "../src/lib/xWebhook";

test("X webhook signatures and CRC use constant provider-compatible HMACs", () => {
  const secret = "tenant-secret";
  const raw = JSON.stringify({ for_user_id: "42" });
  const signature = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("base64");
  assert.equal(verifyXSignature(secret, raw, signature), true);
  assert.match(xCrcResponse(secret, "challenge"), /^sha256=/);
});

test("X activity normalisation ignores our own events and classifies DMs, mentions and replies", () => {
  const events = normaliseXActivity({
    direct_message_events: [
      { id: "dm1", message_create: { sender_id: "customer", target: { recipient_id: "account" }, message_data: { text: "Hi" } } },
      { id: "echo", message_create: { sender_id: "account", target: { recipient_id: "customer" }, message_data: { text: "Hello" } } },
    ],
    tweet_create_events: [
      { id_str: "m1", user: { id_str: "customer2" }, text: "@shop stock?" },
      { id_str: "r1", user: { id_str: "customer3" }, text: "@shop thanks", in_reply_to_status_id_str: "post1" },
    ],
  }, "account");
  assert.deepEqual(events.map((event) => event.kind), ["dm", "mention", "reply"]);
});

test("current X Activity envelopes use the filter user as tenant discriminator and event UUID for dedupe", () => {
  const events = normaliseXActivity({
    data: {
      event_uuid: "delivery-1",
      filter: { user_id: "account" },
      event_type: "post.reply.create",
      payload: { id: "post-1", author_id: "customer", text: "@shop yes please" },
    },
  }, "account");
  assert.deepEqual(events, [{ id: "delivery-1", kind: "reply", senderId: "customer", recipientId: "account", text: "@shop yes please" }]);
});

test("the implementation keeps account resolution and credentials tenant-bound", async () => {
  const fs = await import("node:fs");
  const route = fs.readFileSync("src/app/api/webhooks/x/route.ts", "utf8");
  const oauth = fs.readFileSync("src/app/api/integrations/x/callback/route.ts", "utf8");
  assert.match(route, /resolveChannelTenant\("x", accountId\)/);
  assert.match(route, /resolveTenantCredential\(owner, "X_WEBHOOK_SECRET"\)/);
  assert.match(route, /withChannelTenantScope\("x", accountId/);
  assert.match(oauth, /activeTenantId !== pending\.tenantId/);
});
