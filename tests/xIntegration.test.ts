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

test("current X Activity envelopes key on the post, not on the delivery", () => {
  // This test previously asserted the opposite — that `event_uuid` was the
  // dedupe key. That was the bug: X documents event_uuid as the identifier of
  // the DELIVERY, so a redelivery, or the same post arriving in a second
  // envelope generation, carried a different key and was filed again.
  const events = normaliseXActivity({
    data: {
      event_uuid: "delivery-1",
      filter: { user_id: "account" },
      event_type: "post.reply.create",
      payload: { id: "post-1", author_id: "customer", text: "@shop yes please" },
    },
  }, "account");
  assert.deepEqual(events, [{ id: "post-1", kind: "reply", senderId: "customer", recipientId: "account", text: "@shop yes please" }]);
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




test("an opaque array token is signed, because POST refuses arrays too", () => {
  /*
   * `isIngestibleBody` must match the route EXACTLY, not merely be a superset.
   * The route refuses an array body outright, so an array can never be
   * ingested — and refusing to sign one would be one more opaque token X could
   * legitimately send and receive a 400 for. Repeated CRC failures are how a
   * subscription gets disabled, so over-refusing is an availability bug, not a
   * safe default.
   */
  const secret = "tenant-secret";
  assert.equal(isIngestibleBody('["opaque"]'), false, "an array is not ingestible");
  assert.ok(xCrcResponse(secret, '["opaque"]'), "so it must be signed");
  // The object case is unchanged: still ingestible, still refused.
  assert.equal(isIngestibleBody('{"for_user_id":"1"}'), true);
  assert.equal(xCrcResponse(secret, '{"for_user_id":"1"}'), null);
});



test("the same message keyed identically whichever generation delivers it", () => {
  /*
   * Precedence only settles duplicates WITHIN one payload. Across two separate
   * deliveries — one current, one legacy, which is exactly what a migration
   * produces — nothing suppresses the second. The only thing that can is the id,
   * so it must identify the MESSAGE and not the delivery.
   *
   * `event_uuid` is X's identifier for the delivery. Keying on it meant one DM
   * arriving in both generations produced uuid-1 and dm-1, two dedupe keys, and
   * two inbox rows. It also meant a plain redelivery duplicated, since a
   * redelivery is by definition a new delivery with a new uuid.
   */
  const message = {
    id: "dm-1",
    message_create: {
      sender_id: "9999",
      target: { recipient_id: "1111" },
      message_data: { text: "one message" },
    },
  };

  const viaCurrent = normaliseXActivity(
    { data: { event_type: "dm.received", event_uuid: "uuid-1", payload: { direct_message_events: [message] } } },
    "1111",
  );
  const viaLegacy = normaliseXActivity({ direct_message_events: [message] }, "1111");

  assert.equal(viaCurrent.length, 1);
  assert.equal(viaLegacy.length, 1);
  assert.equal(
    viaCurrent[0].id,
    viaLegacy[0].id,
    "the same DM must carry the same dedupe key in either generation",
  );
  assert.equal(viaCurrent[0].id, "dm-1", "and that key is the message's own id");

  // The same for a post: two deliveries of one reply must agree.
  const post = { id: "post-1", author_id: "9999", text: "@shop hi" };
  const replyNow = normaliseXActivity(
    { data: { event_type: "post.reply.create", event_uuid: "uuid-2", payload: post } },
    "1111",
  );
  const replyLater = normaliseXActivity(
    { data: { event_type: "post.reply.create", event_uuid: "uuid-3", payload: post } },
    "1111",
  );
  assert.equal(replyNow[0].id, replyLater[0].id, "a redelivery must not create a second key");
  assert.equal(replyNow[0].id, "post-1");
});


/* ── only documented generations are parsed ────────────────────────────── */

test("an undocumented envelope shape is ingested by nothing", () => {
  /*
   * A third reader used to accept a generic `events: [{ type, data }]` shape.
   * It matched no X format — X documents the legacy Account Activity payload and
   * the current `data.event_type` envelope, and that was a speculative
   * catch-all present since this integration's first commit.
   *
   * It was not harmlessly unused. It defaulted a missing DM recipient to the
   * connected account, which let another account's private message in; and
   * because nothing says which of its fields is the message id, it keyed on
   * `data.id` while the real readers key on the message, so one DM delivered in
   * that shape and a real one produced two dedupe keys and two inbox rows.
   *
   * Canonicalising it would have meant inventing which field is authoritative in
   * a format that does not exist — the same mistake as inventing a CRC token
   * alphabet. An unrecognised delivery now normalises to nothing, which fails
   * visibly instead.
   */
  const wouldHaveBeenIngested = {
    events: [
      { type: "dm.received", data: { id: "event-1", sender_id: "9999", recipient_id: "1111", text: "hello" } },
    ],
  };
  assert.deepEqual(normaliseXActivity(wouldHaveBeenIngested, "1111"), []);
  assert.deepEqual(normaliseXActivity({ nothing: true }, "1111"), []);
  assert.deepEqual(normaliseXActivity(null, "1111"), []);
});

/* ── the DM recipient rule, across both real generations ───────────────── */

test("a DM addressed to another account is ignored, in both generations", () => {
  const connected = "1111";
  const foreign = "2222";

  assert.deepEqual(
    normaliseXActivity(
      {
        direct_message_events: [
          { id: "e2", message_create: { sender_id: "9999", target: { recipient_id: foreign }, message_data: { text: "hi" } } },
        ],
      },
      connected,
    ),
    [],
    "legacy must check the recipient",
  );

  assert.deepEqual(
    normaliseXActivity(
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
    ),
    [],
    "current must check the recipient",
  );

  // Control: correctly addressed, still ingested.
  const addressed = normaliseXActivity(
    {
      direct_message_events: [
        { id: "ok", message_create: { sender_id: "9999", target: { recipient_id: connected }, message_data: { text: "hi" } } },
      ],
    },
    connected,
  );
  assert.equal(addressed.length, 1);
});

test("a DM that does not name its recipient is refused, not assumed to be ours", () => {
  // `recipient_id ?? accountId` made the check pass vacuously whenever the field
  // was absent. A DM is private; "the payload does not say who this was for"
  // cannot mean "it was for us".
  const connected = "1111";

  assert.deepEqual(
    normaliseXActivity(
      { direct_message_events: [{ id: "e2", message_create: { sender_id: "9999", message_data: { text: "private" } } }] },
      connected,
    ),
    [],
    "legacy: a DM with no recipient must be refused",
  );

  assert.deepEqual(
    normaliseXActivity(
      {
        data: {
          event_type: "dm.received",
          event_uuid: "u1",
          payload: {
            direct_message_events: [{ id: "e3", message_create: { sender_id: "9999", message_data: { text: "private" } } }],
          },
        },
      },
      connected,
    ),
    [],
    "current: a DM with no recipient must be refused",
  );

  // Mentions and replies are PUBLIC and carry no recipient by nature — they must
  // still be ingested, or this hardening would switch off half the feed.
  const mention = normaliseXActivity(
    { tweet_create_events: [{ id_str: "m1", user: { id_str: "9999" }, text: "@shop hi" }] },
    connected,
  );
  assert.equal(mention.length, 1, "a public mention needs no recipient");
  assert.equal(mention[0].kind, "mention");
});

/* ── one reader owns a delivery ────────────────────────────────────────── */

test("a reader that recognises a delivery answers for it, even with nothing to report", () => {
  /*
   * Precedence decided by RESULT could not tell "did not recognise this" from
   * "recognised it and correctly found nothing" — and a current envelope
   * rejecting a cross-account DM produces exactly the latter. It then fell
   * through to a weaker reader, which re-admitted the message.
   *
   * The fallback here carries a perfectly valid DM addressed to the connected
   * account, so the ONLY thing that can suppress it is the current envelope
   * having already answered.
   */
  const connected = "1111";
  const foreign = "2222";

  const isolated = normaliseXActivity(
    {
      data: {
        event_type: "dm.received",
        event_uuid: "uuid-2",
        payload: {
          direct_message_events: [
            {
              id: "dm-2",
              message_create: {
                sender_id: "9999",
                target: { recipient_id: foreign },
                message_data: { text: "for someone else" },
              },
            },
          ],
        },
      },
      direct_message_events: [
        {
          id: "dm-3",
          message_create: {
            sender_id: "9999",
            target: { recipient_id: connected },
            message_data: { text: "would be accepted alone" },
          },
        },
      ],
    },
    connected,
  );
  assert.deepEqual(isolated, [], "the current envelope answered; the fallback must not add to that delivery");

  // Control: that same legacy payload, delivered on its own, IS ingested.
  const alone = normaliseXActivity(
    {
      direct_message_events: [
        {
          id: "dm-3",
          message_create: {
            sender_id: "9999",
            target: { recipient_id: connected },
            message_data: { text: "would be accepted alone" },
          },
        },
      ],
    },
    connected,
  );
  assert.equal(alone.length, 1, "the legacy reader must still work when it owns the delivery");
});

test("an empty container does not suppress a real event beside it", () => {
  /*
   * HONEST NOTE ON WHAT THIS DOES AND DOES NOT PROVE.
   *
   * `recognisesLegacy` requires a NON-EMPTY array. That mattered when a third
   * reader sat after it: `{ direct_message_events: [], events: [valid] }`
   * selected legacy, which had nothing to read, and the valid event was dropped.
   *
   * With that reader removed, legacy is LAST — so `hasEntries` and a bare
   * `Array.isArray` now produce identical results, and mutation testing
   * confirmed it: relaxing the check fails nothing. The precision is kept
   * because it states the intended rule and becomes load-bearing the moment any
   * reader is added after legacy, but this test is a description of current
   * behaviour, not a guard that can catch its removal. Saying so here is better
   * than leaving a test that looks like protection and is not.
   */
  const valid = { id_str: "m1", user: { id_str: "9999" }, text: "@shop hi" };

  const withEmptyDms = normaliseXActivity(
    { direct_message_events: [], tweet_create_events: [valid] },
    "1111",
  );
  assert.equal(withEmptyDms.length, 1, "an empty DM array must not suppress a real tweet event");
  assert.equal(withEmptyDms[0].id, "m1");

  // All containers empty: recognised by nobody, normalises to nothing.
  assert.deepEqual(normaliseXActivity({ direct_message_events: [], tweet_create_events: [] }, "1111"), []);
});
