import crypto from "crypto";

export type XInboundEvent = {
  id: string;
  kind: "dm" | "mention" | "reply";
  senderId: string;
  recipientId: string;
  text: string;
};

/**
 * What a real CRC token may look like.
 *
 * X sends base64 random bytes, so the legal alphabet is small — and the
 * characters it EXCLUDES are the point. A JSON object must contain `{`, `"` and
 * `:`; none of them are here. That is what makes the set of strings this module
 * will sign for a CRC handshake disjoint from the set of strings that can be a
 * webhook body, and it is the whole defence. See `xCrcResponse`.
 */
const CRC_TOKEN = /^[A-Za-z0-9_\-+/=.]{8,256}$/;

export function isCrcToken(token: string): boolean {
  return CRC_TOKEN.test(token);
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
 * from either breaks the integration. So the defence is to narrow what may be
 * signed. A body has to be a JSON object to get as far as verification (the
 * route parses before it verifies), a JSON object must contain `{`, and `{` is
 * not in the CRC alphabet. The two sets cannot overlap.
 *
 * Returns null rather than throwing so the caller answers 400 and the refusal is
 * an ordinary, logged outcome instead of a stack trace on a public endpoint.
 */
export function xCrcResponse(secret: string, token: string): string | null {
  if (!isCrcToken(token)) return null;
  return "sha256=" + crypto.createHmac("sha256", secret).update(token).digest("base64");
}

export function verifyXSignature(secret: string, rawBody: string, signature: string | null): boolean {
  if (!secret || !signature) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Accepts X Activity envelopes and the legacy-shaped events used during migration. */
export function normaliseXActivity(payload: unknown, accountId: string): XInboundEvent[] {
  // Multiple X Activity API generations use different envelopes. Keep the
  // provider boundary loose, then normalise only checked scalar fields below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = payload as Record<string, any>;
  const result: XInboundEvent[] = [];
  // Current X Activity API: one event per { data: { event_uuid, filter,
  // event_type, payload } } envelope.
  const activity = body.data;
  if (activity?.event_type && activity?.payload) {
    const type = String(activity.event_type);
    const eventPayload = activity.payload;
    if (type === "dm.received") {
      for (const dm of eventPayload.direct_message_events ?? []) {
        const create = dm.message_create ?? {};
        const senderId = String(create.sender_id ?? "");
        const recipientId = String(create.target?.recipient_id ?? accountId);
        const text = String(create.message_data?.text ?? "");
        if (dm.id && senderId && senderId !== accountId && recipientId === accountId && text) {
          result.push({ id: String(activity.event_uuid ?? dm.id), kind: "dm", senderId, recipientId, text });
        }
      }
    } else if (type === "post.mention.create" || type === "post.reply.create") {
      const senderId = String(eventPayload.author_id ?? "");
      const text = String(eventPayload.text ?? "");
      if (senderId && senderId !== accountId && eventPayload.id && text) {
        result.push({
          id: String(activity.event_uuid ?? eventPayload.id),
          kind: type === "post.reply.create" ? "reply" : "mention",
          senderId, recipientId: accountId, text,
        });
      }
    }
    /*
     * The current envelope is AUTHORITATIVE — the legacy readers below do not
     * also run over the same payload.
     *
     * They are fallbacks for older Activity generations, not extra passes. Left
     * unconditional, a transitional payload carrying both shapes (exactly what
     * these fallbacks exist to survive) yields the same logical DM twice — and
     * because this branch keys on `event_uuid` while the legacy one keys on the
     * message `id`, the two carry DIFFERENT dedupe keys, so the provider-id
     * check in recordInboundDm cannot collapse them and the customer's message
     * is filed to the inbox twice.
     */
    return result;
  }
  for (const event of body.direct_message_events ?? []) {
    const create = event.message_create ?? {};
    const senderId = String(create.sender_id ?? "");
    const recipientId = String(create.target?.recipient_id ?? accountId);
    const text = String(create.message_data?.text ?? "");
    if (event.id && senderId && recipientId === accountId && senderId !== accountId && text) {
      result.push({ id: String(event.id), kind: "dm", senderId, recipientId, text });
    }
  }
  for (const tweet of body.tweet_create_events ?? []) {
    const senderId = String(tweet.user?.id_str ?? tweet.user?.id ?? "");
    const text = String(tweet.extended_tweet?.full_text ?? tweet.text ?? "");
    if (tweet.id_str && senderId && senderId !== accountId && text) {
      result.push({
        id: String(tweet.id_str),
        kind: tweet.in_reply_to_status_id_str ? "reply" : "mention",
        senderId,
        recipientId: accountId,
        text,
      });
    }
  }
  for (const event of body.events ?? []) {
    const data = event.data ?? event;
    const type = String(event.type ?? data.event_type ?? "");
    const senderId = String(data.sender_id ?? data.author_id ?? "");
    const recipientId = String(data.recipient_id ?? accountId);
    const text = String(data.text ?? data.message?.text ?? "");
    const id = String(data.id ?? event.id ?? "");
    if (!id || !senderId || senderId === accountId || !text) continue;
    // A DM must be addressed to the account this webhook is FOR. The other two
    // DM branches check this; this one did not, and the omission is not
    // cosmetic — an app may hold Activity subscriptions for several users, so
    // without it a private message sent to somebody else's account is ingested
    // into this workspace's inbox and can raise a lead off it.
    if (type.includes("dm")) {
      if (recipientId === accountId) result.push({ id, kind: "dm", senderId, recipientId, text });
    }
    else if (type.includes("reply")) result.push({ id, kind: "reply", senderId, recipientId: accountId, text });
    else if (type.includes("mention")) result.push({ id, kind: "mention", senderId, recipientId: accountId, text });
  }
  return result;
}
