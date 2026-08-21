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
  // Arrays are excluded from ingest for the same reason objects are included:
  // the route reads named discriminators off the body, which an array cannot
  // carry. They are treated as ingestible here ANYWAY — refusing to sign one
  // costs nothing, and it keeps this predicate a superset of what the route
  // accepts rather than something that has to track it exactly.
  return typeof parsed === "object" && parsed !== null;
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
      const recipientId = String(create.target?.recipient_id ?? accountId);
      const text = String(create.message_data?.text ?? "");
      if (dm.id && senderId && senderId !== accountId && recipientId === accountId && text) {
        out.push({ id: String(activity.event_uuid ?? dm.id), kind: "dm", senderId, recipientId, text });
      }
    }
  } else if (type === "post.mention.create" || type === "post.reply.create") {
    const senderId = String(eventPayload.author_id ?? "");
    const text = String(eventPayload.text ?? "");
    if (senderId && senderId !== accountId && eventPayload.id && text) {
      out.push({
        id: String(activity.event_uuid ?? eventPayload.id),
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
    const recipientId = String(create.target?.recipient_id ?? accountId);
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
    const recipientId = String(data.recipient_id ?? accountId);
    const text = String(data.text ?? data.message?.text ?? "");
    const id = String(data.id ?? event.id ?? "");
    if (!id || !senderId || senderId === accountId || !text) continue;
    // A DM must be addressed to the account this webhook is FOR. An app may hold
    // Activity subscriptions for several users, so without this a private message
    // sent to somebody else's account is ingested into this workspace's inbox and
    // can raise a lead off it.
    if (type.includes("dm")) {
      if (recipientId === accountId) out.push({ id, kind: "dm", senderId, recipientId, text });
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
 * Precedence rather than id-normalisation: the shapes disagree about WHICH id is
 * canonical, so there is no single provider id to normalise onto without
 * inventing a rule about which generation's identifier is authoritative. Picking
 * the most current reader that recognises the payload settles it with no such
 * invention.
 */
export function normaliseXActivity(payload: unknown, accountId: string): XInboundEvent[] {
  const body = payload as Envelope;
  if (!body || typeof body !== "object") return [];
  for (const read of [readActivityEnvelope, readLegacyEnvelope, readGenericEnvelope]) {
    const events = read(body, accountId);
    if (events.length > 0) return events;
  }
  return [];
}
