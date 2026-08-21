import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import { isIngestibleBody, normaliseXActivity, verifyXSignature, xCrcResponse } from "../src/lib/xWebhook";

test("X webhook signatures and CRC use constant provider-compatible HMACs", () => {
  const secret = "tenant-secret";
  const raw = JSON.stringify({ for_user_id: "42" });
  const signature = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("base64");
  assert.equal(verifyXSignature(secret, raw, signature), true);
  const crc = xCrcResponse(secret, "challenge");
  assert.ok(crc, "a well-formed CRC token must still be answered");
  assert.match(crc, /^sha256=/);
});

/* ── the CRC endpoint must not be a signing oracle ─────────────────────── */

test("the CRC handshake refuses to sign anything that could be a webhook body", () => {
  /*
   * THE ATTACK THIS CLOSES, because it is not obvious from either side alone.
   *
   * X defines both halves with the same construction: the CRC reply is
   * `sha256=` + base64(HMAC(secret, crc_token)), and the POST signature is
   * `sha256=` + base64(HMAC(secret, rawBody)). Same secret, same algorithm, same
   * framing — so a CRC reply IS a valid body signature for whatever was passed
   * as the token. The route is in the proxy's PUBLIC_PATHS because X must reach
   * it unauthenticated, so before this an anonymous caller could ask for a
   * signature over the exact JSON of a fabricated DM and then POST it.
   *
   * Domain separation is unavailable — both formats are X's. So the defence is
   * narrowed to exactly the overlap: the route acts only on a body that parses
   * as a JSON object, so that is the only thing the handshake refuses to sign.
   * Everything else X might send as an opaque challenge is answered normally.
   */
  const secret = "tenant-secret";
  const forgedBody = JSON.stringify({
    for_user_id: "1111",
    direct_message_events: [
      {
        id: "forged",
        message_create: {
          sender_id: "9999",
          target: { recipient_id: "1111" },
          message_data: { text: "Forged" },
        },
      },
    ],
  });

  assert.equal(xCrcResponse(secret, forgedBody), null, "a JSON body must never be signed");
  assert.equal(isIngestibleBody(forgedBody), true);

  // The property that actually matters, stated directly: nothing the CRC
  // endpoint will sign can be a body the POST path would accept, because the
  // route parses JSON before it verifies and no signable token parses to an
  // object.
  for (const hostile of [
    forgedBody,
    '{"a":1}',
    '{}',
    ' {"for_user_id":"1"} ',
    '["x"]',
  ]) {
    assert.equal(xCrcResponse(secret, hostile), null, `must refuse: ${hostile}`);
  }

  /*
   * X documents crc_token as an OPAQUE challenge and promises nothing about its
   * alphabet or length; its own reference implementation signs any non-empty
   * token. So the guard must not invent a format — a token X sends that we
   * refuse is a 400, and repeated CRC failures are how X disables a webhook
   * subscription. Each of these would have been rejected by an alphabet rule and
   * must be answered.
   */
  for (const opaque of [
    "cGxlYXNlLXNpZ24tdGhpcw==",
    "abc",                                  // shorter than any invented minimum
    "x".repeat(4096),                       // longer than any invented maximum
    "token with spaces",
    "tok:en/with?punctuation&more",
    'challenge"; DROP',                     // quotes and punctuation, still not JSON
    "unicode-éèê",
    "123",                                  // parses as JSON, but not an object
    '"a string"',                           // parses as JSON, but not an object
    "null",
  ]) {
    assert.ok(xCrcResponse(secret, opaque), `must accept opaque token: ${opaque.slice(0, 24)}`);
  }
  assert.equal(xCrcResponse(secret, ""), null, "an empty token is not a challenge");
});

test("a CRC reply cannot be replayed as a signature for a JSON body", () => {
  // The end-to-end version of the guard above: run the exact attack and assert
  // it now fails at step one. If xCrcResponse ever returns a string here, the
  // forgery works again.
  const secret = "tenant-secret";
  const body = JSON.stringify({ for_user_id: "1111", events: [] });
  const oracle = xCrcResponse(secret, body);
  assert.equal(oracle, null, "the oracle must be closed");
  // Belt and braces: were one ever produced, this is what it would defeat.
  const wouldHaveBeen =
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(
    verifyXSignature(secret, body, wouldHaveBeen),
    true,
    "this is why the CRC endpoint must never sign a body: the value verifies",
  );
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

/* ── every DM parser must check who the message was addressed to ───────── */

test("a DM addressed to another account is ignored, in every envelope shape", () => {
  /*
   * An X app can hold Activity subscriptions for more than one user, and all of
   * their events arrive at the same webhook. `accountId` is which account this
   * delivery is FOR, so a message whose recipient is somebody else belongs to a
   * different subscription — ingesting it puts a private DM sent to another
   * account into this workspace's inbox, where it can raise a lead.
   *
   * Three of the four parser branches checked this. The `events` branch did not.
   */
  const connected = "1111";
  const foreign = "2222";

  const viaEvents = normaliseXActivity(
    { events: [{ type: "dm.received", data: { id: "e1", sender_id: "9999", recipient_id: foreign, text: "hi" } }] },
    connected,
  );
  assert.deepEqual(viaEvents, [], "the events envelope must check the recipient");

  const viaLegacy = normaliseXActivity(
    {
      direct_message_events: [
        { id: "e2", message_create: { sender_id: "9999", target: { recipient_id: foreign }, message_data: { text: "hi" } } },
      ],
    },
    connected,
  );
  assert.deepEqual(viaLegacy, [], "the legacy envelope must check the recipient");

  const viaCurrent = normaliseXActivity(
    {
      data: {
        event_type: "dm.received",
        event_uuid: "u1",
        payload: {
          direct_message_events: [
            { id: "e3", message_create: { sender_id: "9999", target: { recipient_id: foreign }, message_data: { text: "hi" } } },
          ],
        },
      },
    },
    connected,
  );
  assert.deepEqual(viaCurrent, [], "the current envelope must check the recipient");

  // The control: correctly addressed, via the branch that was broken.
  const addressed = normaliseXActivity(
    { events: [{ type: "dm.received", data: { id: "ok", sender_id: "9999", recipient_id: connected, text: "hi" } }] },
    connected,
  );
  assert.equal(addressed.length, 1, "a DM to this account must still be accepted");
});

test("the current envelope is authoritative, so one message cannot file twice", () => {
  /*
   * The legacy readers are fallbacks for older Activity generations, not extra
   * passes over the same payload. A transitional delivery carrying both shapes
   * is exactly what they exist to survive — and if both ran, the same DM would
   * be emitted twice with DIFFERENT ids (`event_uuid` here, message `id` there),
   * so the provider-id dedupe in recordInboundDm could not collapse them and the
   * customer's message would appear in the inbox twice.
   */
  const both = normaliseXActivity(
    {
      data: {
        event_type: "dm.received",
        event_uuid: "uuid-1",
        payload: {
          direct_message_events: [
            { id: "dm-1", message_create: { sender_id: "9999", target: { recipient_id: "1111" }, message_data: { text: "hi" } } },
          ],
        },
      },
      direct_message_events: [
        { id: "dm-1", message_create: { sender_id: "9999", target: { recipient_id: "1111" }, message_data: { text: "hi" } } },
      ],
    },
    "1111",
  );
  assert.equal(both.length, 1, "one logical message, one event");
  assert.equal(both[0].id, "uuid-1", "the current envelope's id wins");
});

test("exactly one reader answers a delivery, whichever shapes it carries", () => {
  /*
   * The first attempt at this only stopped the CURRENT envelope from being
   * re-read by the fallbacks; the two fallbacks still ran together. A payload
   * carrying the same DM as both `direct_message_events` and `events` produced
   * two events with different ids — and different ids are different transcript
   * dedupe keys, so the message was still filed twice.
   *
   * Precedence is now applied across every shape: the most current reader that
   * recognises the payload answers for the whole delivery.
   */
  const dm = {
    id: "dm-1",
    message_create: {
      sender_id: "9999",
      target: { recipient_id: "1111" },
      message_data: { text: "same message" },
    },
  };
  const generic = {
    type: "dm.received",
    data: { id: "event-1", sender_id: "9999", recipient_id: "1111", text: "same message" },
  };

  // The pair the review reproduced: both FALLBACK shapes, no current envelope.
  const bothFallbacks = normaliseXActivity({ direct_message_events: [dm], events: [generic] }, "1111");
  assert.equal(bothFallbacks.length, 1, "one logical message, one event");
  assert.equal(bothFallbacks[0].id, "dm-1", "the legacy reader outranks the generic one");

  // All three shapes at once.
  const allThree = normaliseXActivity(
    {
      data: {
        event_type: "dm.received",
        event_uuid: "uuid-1",
        payload: { direct_message_events: [dm] },
      },
      direct_message_events: [dm],
      events: [generic],
    },
    "1111",
  );
  assert.equal(allThree.length, 1, "one logical message, one event");
  assert.equal(allThree[0].id, "uuid-1", "the current envelope outranks both fallbacks");

  // A lower-precedence reader still answers when the higher ones recognise
  // nothing — otherwise this fix would silently drop older deliveries.
  const genericOnly = normaliseXActivity({ events: [generic] }, "1111");
  assert.equal(genericOnly.length, 1);
  assert.equal(genericOnly[0].id, "event-1");

  // An unrecognised payload is empty, not a throw.
  assert.deepEqual(normaliseXActivity({ nothing: true }, "1111"), []);
  assert.deepEqual(normaliseXActivity(null, "1111"), []);
});
