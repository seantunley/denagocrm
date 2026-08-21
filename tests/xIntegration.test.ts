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
  // The MESSAGE's id, not the delivery's — which is also why this value is the
  // same whichever envelope ends up answering.
  assert.equal(both[0].id, "dm-1", "the current envelope answers, keyed on the message");
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
  assert.equal(allThree[0].id, "dm-1", "the current envelope outranks both fallbacks, keyed on the message");

  // A lower-precedence reader still answers when the higher ones recognise
  // nothing — otherwise this fix would silently drop older deliveries.
  const genericOnly = normaliseXActivity({ events: [generic] }, "1111");
  assert.equal(genericOnly.length, 1);
  assert.equal(genericOnly[0].id, "event-1");

  // An unrecognised payload is empty, not a throw.
  assert.deepEqual(normaliseXActivity({ nothing: true }, "1111"), []);
  assert.deepEqual(normaliseXActivity(null, "1111"), []);
});

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

test("a reader that recognises a delivery answers for it, even with nothing to report", () => {
  /*
   * THE SEQUENCE THIS CLOSES, which was worse than the duplicate it replaced.
   *
   * Precedence used to be decided by "the first reader that returned events".
   * A current envelope holding a DM for account 2222, read for connected account
   * 1111, correctly yields NOTHING — and an empty result was indistinguishable
   * from "this reader did not recognise the payload". So parsing fell through to
   * the generic reader, which saw a copy of the same message with no
   * `recipient_id`, defaulted the missing recipient to 1111, and accepted the
   * private DM. The cross-account protection defeated itself at the exact moment
   * it was working.
   *
   * Selection is now by SHAPE. A recognised envelope answers for the delivery,
   * including when the honest answer is no events at all.
   */
  const connected = "1111";
  const foreign = "2222";

  const fellThrough = normaliseXActivity(
    {
      // Recognised, and correctly rejects: the DM is for somebody else.
      data: {
        event_type: "dm.received",
        event_uuid: "uuid-1",
        payload: {
          direct_message_events: [
            {
              id: "dm-1",
              message_create: {
                sender_id: "9999",
                target: { recipient_id: foreign },
                message_data: { text: "private" },
              },
            },
          ],
        },
      },
      // The weaker copy of the same message, with the recipient omitted.
      events: [{ type: "dm.received", data: { id: "event-1", sender_id: "9999", text: "private" } }],
    },
    connected,
  );
  assert.deepEqual(fellThrough, [], "a rejected current envelope must not be retried by a weaker reader");

  /*
   * The case above is blocked twice over — by shape precedence AND by the
   * recipient rule — so on its own it cannot tell which fix is doing the work.
   * (Mutation testing caught exactly that: reverting precedence alone failed
   * nothing.) This isolates precedence: the fallback here carries a PERFECTLY
   * VALID DM addressed to the connected account, so the only thing that can
   * suppress it is the current envelope having already answered.
   */
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
      events: [
        {
          type: "dm.received",
          data: { id: "event-2", sender_id: "9999", recipient_id: connected, text: "would be accepted alone" },
        },
      ],
    },
    connected,
  );
  assert.deepEqual(
    isolated,
    [],
    "the current envelope answered; a fallback must not add events to that delivery",
  );

  // Control: the same fallback, delivered on its own, IS ingested — otherwise
  // this guard would pass simply because the generic reader stopped working.
  const fallbackAlone = normaliseXActivity(
    {
      events: [
        {
          type: "dm.received",
          data: { id: "event-2", sender_id: "9999", recipient_id: connected, text: "would be accepted alone" },
        },
      ],
    },
    connected,
  );
  assert.equal(fallbackAlone.length, 1, "the generic reader must still work when it owns the delivery");
});

test("a DM that does not name its recipient is refused, not assumed to be ours", () => {
  // `recipient_id ?? accountId` made the recipient check pass vacuously whenever
  // the field was absent. A DM is private; "the payload does not say who this
  // was for" cannot mean "it was for us".
  const connected = "1111";

  assert.deepEqual(
    normaliseXActivity(
      { events: [{ type: "dm.received", data: { id: "e1", sender_id: "9999", text: "private" } }] },
      connected,
    ),
    [],
    "generic: a DM with no recipient must be refused",
  );

  assert.deepEqual(
    normaliseXActivity(
      {
        direct_message_events: [
          { id: "e2", message_create: { sender_id: "9999", message_data: { text: "private" } } },
        ],
      },
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
            direct_message_events: [
              { id: "e3", message_create: { sender_id: "9999", message_data: { text: "private" } } },
            ],
          },
        },
      },
      connected,
    ),
    [],
    "current: a DM with no recipient must be refused",
  );

  // Mentions and replies are PUBLIC and carry no recipient by nature — they must
  // still be ingested, or this hardening would silently switch off half the feed.
  const mention = normaliseXActivity(
    { events: [{ type: "post.mention.create", data: { id: "m1", author_id: "9999", text: "@shop hi" } }] },
    connected,
  );
  assert.equal(mention.length, 1, "a public mention needs no recipient");
  assert.equal(mention[0].kind, "mention");
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

test("an empty legacy array does not claim a delivery it is not carrying", () => {
  /*
   * `recognisesLegacy` claimed ANY array, so `{ direct_message_events: [],
   * events: [valid] }` selected the legacy reader, which had nothing to read,
   * and the valid generic event was silently dropped. An empty container is not
   * evidence of a generation.
   */
  const valid = {
    type: "dm.received",
    data: { id: "event-1", sender_id: "9999", recipient_id: "1111", text: "hello" },
  };

  const withEmptyLegacy = normaliseXActivity(
    { direct_message_events: [], events: [valid] },
    "1111",
  );
  assert.equal(withEmptyLegacy.length, 1, "an empty legacy array must not suppress a real generic event");
  assert.equal(withEmptyLegacy[0].id, "event-1");

  const withEmptyTweets = normaliseXActivity(
    { tweet_create_events: [], events: [valid] },
    "1111",
  );
  assert.equal(withEmptyTweets.length, 1, "the same for an empty tweet array");

  // A delivery whose containers are all empty is recognised by nobody and
  // normalises to nothing, which is the correct reading of an empty payload.
  assert.deepEqual(normaliseXActivity({ direct_message_events: [], events: [] }, "1111"), []);
});
