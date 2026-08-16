import crypto from "crypto";

export type XInboundEvent = {
  id: string;
  kind: "dm" | "mention" | "reply";
  senderId: string;
  recipientId: string;
  text: string;
};

export function xCrcResponse(secret: string, token: string): string {
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
    if (type.includes("dm")) result.push({ id, kind: "dm", senderId, recipientId, text });
    else if (type.includes("reply")) result.push({ id, kind: "reply", senderId, recipientId: accountId, text });
    else if (type.includes("mention")) result.push({ id, kind: "mention", senderId, recipientId: accountId, text });
  }
  return result;
}
