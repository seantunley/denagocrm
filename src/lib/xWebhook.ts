import crypto from "crypto";

export type XInboundEvent = {
  id: string;
  kind: "dm" | "mention" | "reply";
  senderId: string;
  recipientId: string;
  text: string;
};

/**
 * Is this text something the POST path could ingest as a webhook body?
 *
 * This is the ONLY question that decides what the CRC handshake will sign, and
 * it is deliberately derived from the ingest side rather than from any guess
 * about X's token format.
 *
 * An earlier version of this fix restricted tokens to a base64-ish alphabet of
 * 8–256 characters. That was wrong in a way worth recording: X documents
 * `crc_token` as an opaque challenge string and promises nothing about its
 * alphabet or length — its own reference implementation signs any non-empty
 * token. Inventing a format meant a token outside it would be answered with 400,
 * and repeated CRC failures are how X disables a webhook subscription. The fix
 * would have traded a forgery hole for an availability one.
 *
 * So the rule is narrowed to exactly the overlap: `isIngestibleBody` is true for
 * text that parses as a JSON object, which is the only thing `POST` will act on
 * (see the route, which refuses a body that is not one). Everything else — every
 * opaque token X might ever send — is signed as normal.
 */
export function isIngestibleBody(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON at all, so the POST path could never act on it.
    return false;
  }
  // Arrays are NOT ingestible: the route refuses them explicitly, because it
  // reads named discriminators off the body and an array carries none. So this
  // excludes them too.
  //
  // Being a superset of what the route accepts would be safe for forgery and
  // wrong for availability — every extra thing refused here is an opaque token X
  // might legitimately send and get a 400 for, and repeated CRC failures are how
  // a subscription gets disabled. The predicate matches the route EXACTLY, in
  // both directions.
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
}

/**
 * The CRC handshake response — or null if the token is not one X would send.
 *
 * ── WHY THIS REFUSES ANYTHING, WHEN A HANDSHAKE LOOKS HARMLESS ──────────────
 *
 * Signing arbitrary text here is remote code for "forge any webhook you like".
 * X's Activity API defines BOTH sides of this integration with the same
 * construction: the CRC reply is `sha256=` + base64(HMAC-SHA256(secret, token)),
 * and the POST signature is `sha256=` + base64(HMAC-SHA256(secret, rawBody)).
 * Same secret, same algorithm, same framing — so a CRC reply IS a valid body
 * signature for whatever text was passed as the token.
 *
 * The route serving this is in the proxy's PUBLIC_PATHS, because X has to reach
 * it unauthenticated. So without this check anybody could: ask for a signature
 * over the exact JSON of a fabricated inbound DM, then POST that JSON with the
 * returned value as `x-twitter-webhooks-signature`. It verifies, and a forged
 * customer message enters the Social Inbox and creates a CRM lead.
 *
 * Domain separation — prefixing one side, or using a second key — is the usual
 * answer and is NOT available: both formats are dictated by X, and diverging
 * from either breaks the integration. So the defence narrows what may be signed,
 * to exactly the overlap and no further: the route will only act on a body that
 * parses as a JSON object, so that is the one thing this refuses to sign.
 *
 * Anything else X sends as an opaque challenge is answered normally, which
 * matters because X promises nothing about the token's shape and a wrongly
 * refused handshake eventually disables the subscription. See
 * `isIngestibleBody`.
 *
 * Returns null rather than throwing so the caller answers 400 and the refusal is
 * an ordinary, logged outcome instead of a stack trace on a public endpoint.
 */
export function xCrcResponse(secret: string, token: string): string | null {
  if (!token || isIngestibleBody(token)) return null;
  return "sha256=" + crypto.createHmac("sha256", secret).update(token).digest("base64");
}

export function verifyXSignature(secret: string, rawBody: string, signature: string | null): boolean {
  if (!secret || !signature) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The provider boundary is loose; every field is checked before it is used. */
type Envelope = Record<string, any>;

/**
 * The recipient a DM was addressed to, or null when the payload does not say.
 *
 * DEFAULTING A MISSING RECIPIENT TO "us" IS THE BUG THIS EXISTS TO PREVENT.
 * `recipient_id ?? accountId` makes the check `recipientId === accountId` pass
 * vacuously whenever the field is absent — so a shape that omits it is accepted
 * without anything having proved the message was ours. A DM is private, and the
 * only safe reading of "the payload does not say who this was for" is that we
 * cannot claim it. Absent means refuse, and a delivery X really does send
 * without a recipient fails visibly rather than being ingested wrongly.
 */
function dmRecipient(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  return value.length > 0 ? value : null;
}

/**
 * Which reader OWNS a payload, decided by its shape alone.
 *
 * Selecting by shape rather than by "the first reader that produced something"
 * is the whole point, and getting that wrong was a worse bug than the duplicate
 * it replaced: a current envelope carrying a DM for another account correctly
 * yields NO events, and a result-based rule reads that emptiness as "this reader
 * did not recognise the payload" and tries the weaker ones. A generic copy of
 * the same delivery that omits `recipient_id` would then be accepted — so the
 * cross-account protection defeated itself precisely when it was working.
 *
 * A reader that recognises its shape answers for the whole delivery, including
 * when the honest answer is nothing at all.
 */
function recognisesActivity(body: Envelope): boolean {
  // A definitive discriminator rather than a container: `event_type` names the
  // generation outright, so this is true exactly when the delivery IS a current
  // envelope, empty payload or not.
  return Boolean(body.data?.event_type && body.data?.payload);
}

/**
 * Recognition requires a NON-EMPTY array, and that is not fussiness.
 *
 * Claiming any array meant `{ direct_message_events: [], events: [valid] }`
 * selected the legacy reader, which had nothing to read, and the valid generic
 * event was silently dropped — a delivery answered by a reader that was never
 * carrying it. An empty container is not evidence of a generation; it is
 * evidence of nothing.
 *
 * A delivery whose arrays are all empty is recognised by nobody and normalises
 * to no events, which is the correct reading of a payload with no events in it.
 */
function hasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function recognisesLegacy(body: Envelope): boolean {
  return hasEntries(body.direct_message_events) || hasEntries(body.tweet_create_events);
}

function recognisesGeneric(body: Envelope): boolean {
  return hasEntries(body.events);
}

/**
 * The current X Activity envelope: { data: { event_uuid, filter, event_type,
 * payload } }.
 */
function readActivityEnvelope(body: Envelope, accountId: string): XInboundEvent[] {
  const activity = body.data;
  if (!activity?.event_type || !activity?.payload) return [];
  const out: XInboundEvent[] = [];
  const type = String(activity.event_type);
  const eventPayload = activity.payload;
  if (type === "dm.received") {
    for (const dm of eventPayload.direct_message_events ?? []) {
      const create = dm.message_create ?? {};
      const senderId = String(create.sender_id ?? "");
      const recipientId = dmRecipient(create.target?.recipient_id);
      const text = String(create.message_data?.text ?? "");
      if (dm.id && senderId && senderId !== accountId && recipientId === accountId && text) {
        // `dm.id`, NOT `activity.event_uuid` — see the note on canonical ids
        // above `normaliseXActivity`.
        out.push({ id: String(dm.id), kind: "dm", senderId, recipientId, text });
      }
    }
  } else if (type === "post.mention.create" || type === "post.reply.create") {
    const senderId = String(eventPayload.author_id ?? "");
    const text = String(eventPayload.text ?? "");
    if (senderId && senderId !== accountId && eventPayload.id && text) {
      out.push({
        // The post's own id, not the delivery's — see the canonical-id note.
        id: String(eventPayload.id),
        kind: type === "post.reply.create" ? "reply" : "mention",
        senderId, recipientId: accountId, text,
      });
    }
  }
  return out;
}

/** Legacy top-level `direct_message_events` / `tweet_create_events`. */
function readLegacyEnvelope(body: Envelope, accountId: string): XInboundEvent[] {
  const out: XInboundEvent[] = [];
  for (const event of body.direct_message_events ?? []) {
    const create = event.message_create ?? {};
    const senderId = String(create.sender_id ?? "");
    const recipientId = dmRecipient(create.target?.recipient_id);
    const text = String(create.message_data?.text ?? "");
    if (event.id && senderId && recipientId === accountId && senderId !== accountId && text) {
      out.push({ id: String(event.id), kind: "dm", senderId, recipientId, text });
    }
  }
  for (const tweet of body.tweet_create_events ?? []) {
    const senderId = String(tweet.user?.id_str ?? tweet.user?.id ?? "");
    const text = String(tweet.extended_tweet?.full_text ?? tweet.text ?? "");
    if (tweet.id_str && senderId && senderId !== accountId && text) {
      out.push({
        id: String(tweet.id_str),
        kind: tweet.in_reply_to_status_id_str ? "reply" : "mention",
        senderId,
        recipientId: accountId,
        text,
      });
    }
  }
  return out;
}

/** The generic `events: [...]` shape. */
function readGenericEnvelope(body: Envelope, accountId: string): XInboundEvent[] {
  const out: XInboundEvent[] = [];
  for (const event of body.events ?? []) {
    const data = event.data ?? event;
    const type = String(event.type ?? data.event_type ?? "");
    const senderId = String(data.sender_id ?? data.author_id ?? "");
    const recipientId = dmRecipient(data.recipient_id);
    const text = String(data.text ?? data.message?.text ?? "");
    const id = String(data.id ?? event.id ?? "");
    if (!id || !senderId || senderId === accountId || !text) continue;
    // A DM must be PROVABLY addressed to the account this webhook is for. An app
    // may hold Activity subscriptions for several users, so a private message
    // sent to somebody else's account would otherwise be ingested into this
    // workspace's inbox and raise a lead off it. A payload that does not name a
    // recipient proves nothing, so it is refused rather than assumed — see
    // `dmRecipient`.
    if (type.includes("dm")) {
      if (recipientId && recipientId === accountId) {
        out.push({ id, kind: "dm", senderId, recipientId, text });
      }
    } else if (type.includes("reply")) {
      out.push({ id, kind: "reply", senderId, recipientId: accountId, text });
    } else if (type.includes("mention")) {
      out.push({ id, kind: "mention", senderId, recipientId: accountId, text });
    }
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Accepts X Activity envelopes and the legacy shapes used during migration.
 *
 * ── EXACTLY ONE READER WINS ─────────────────────────────────────────────────
 *
 * The three readers are ALTERNATIVES, in descending order of how current the
 * generation is — not passes to be summed. The first one that recognises the
 * payload answers for the whole delivery.
 *
 * Running them all was a duplicate-ingestion bug, and it is worth being precise
 * about why, because the shapes look disjoint and are not. Each generation keys
 * its events differently: the current envelope carries a delivery `event_uuid`,
 * the legacy one the DM's own `id`, the generic one whatever `data.id` holds. So
 * one logical message appearing in two shapes produces two events with DIFFERENT
 * ids, the provider-id dedupe in recordInboundDm sees two distinct keys, and the
 * customer's message is filed to the inbox twice.
 *
 * A transitional delivery carrying more than one shape is not hypothetical — it
 * is exactly the case these fallbacks exist to survive, which is what makes
 * summing them the wrong instinct.
 *
 * ── THE ID IS THE MESSAGE'S, NEVER THE DELIVERY'S ───────────────────────────
 *
 * Precedence settles duplicates WITHIN one payload. It does nothing across two
 * separate deliveries, and X can send the same message twice — once per
 * generation during a migration, or again after a resubscribe.
 *
 * So the id emitted here is always the underlying provider object: the DM's own
 * `id`, or the post's `id`. Never `event_uuid`, which X documents as the
 * identifier of the DELIVERY rather than of the thing delivered. Keying on it
 * meant the same DM arriving in a current envelope and a legacy one produced two
 * different dedupe keys, so `recordInboundDm` filed it twice — and it meant a
 * simple redelivery of one message would duplicate too, since a redelivery is by
 * definition a new delivery with a new uuid.
 *
 * Every reader therefore emits the same id for the same message, whatever shape
 * carried it, which is what makes the provider-id dedupe downstream actually
 * work.
 */
export function normaliseXActivity(payload: unknown, accountId: string): XInboundEvent[] {
  const body = payload as Envelope;
  if (!body || typeof body !== "object") return [];
  const readers: [(body: Envelope) => boolean, (body: Envelope, accountId: string) => XInboundEvent[]][] = [
    [recognisesActivity, readActivityEnvelope],
    [recognisesLegacy, readLegacyEnvelope],
    [recognisesGeneric, readGenericEnvelope],
  ];
  for (const [recognises, read] of readers) {
    // Selected on SHAPE, and answering even when the answer is no events. A
    // reader that recognised the delivery has spoken for it; falling through on
    // an empty result is what let a rejected cross-account DM be re-admitted by
    // a weaker representation of the same message.
    if (recognises(body)) return read(body, accountId);
  }
  return [];
}
