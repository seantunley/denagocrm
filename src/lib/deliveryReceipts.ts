/**
 * "Delivered" and "Seen" for messages we sent to a customer.
 *
 * THE MODEL IS A WATERMARK, NOT A PER-MESSAGE FLAG, and that is not a shortcut —
 * it is what Meta actually sends. A Messenger `read` event carries a single
 * timestamp meaning "everything up to here has been seen", with no message ids at
 * all. Storing it any other way would be inventing precision the platform does
 * not give us.
 *
 * WhatsApp is the exception: its `statuses` are per message id and exact. It is
 * still applied as a watermark here: the WhatsApp senders now return the wamid
 * (stored on the outbox row and Communication.messageId), but rows written before
 * that have none, and the watermark covers both. `failed` IS matched by wamid —
 * see whatsappFailure. The inference is sound either way: WhatsApp
 * marks a conversation read in order, so if a message was read at T, the ones
 * before it were too.
 *
 * Pure, so the ordering rules are testable without a webhook.
 */

/** How far a message has got. Ordered: seen implies delivered. */
export type ReceiptLevel = "delivered" | "seen";

export type Receipt = {
  /** Which channel's messages this applies to. */
  channel: "messenger" | "instagram" | "whatsapp";
  /** The platform's id for the customer: PSID, IG-scoped id, or phone digits. */
  recipientRef: string;
  level: ReceiptLevel;
  /** Everything we sent them at or before this moment has reached that level. */
  at: Date;
};

/**
 * A Meta messaging event, if it is a delivery or read receipt.
 *
 * Meta's watermark is milliseconds since the epoch. A malformed or absent one is
 * rejected rather than defaulted: a watermark of 0 would mark nothing, and a
 * watermark of "now" would mark the entire conversation seen on a bad payload.
 */
export function metaReceipt(
  event: {
    sender?: { id?: unknown };
    delivery?: { watermark?: unknown };
    read?: { watermark?: unknown };
  },
  channel: "messenger" | "instagram",
): Receipt | null {
  const recipientRef = typeof event.sender?.id === "string" ? event.sender.id : String(event.sender?.id ?? "");
  if (!recipientRef) return null;

  // Read is checked first: an event carrying both is at the higher level, and
  // applying delivered afterwards would be a no-op anyway.
  const raw = event.read?.watermark ?? event.delivery?.watermark;
  const level: ReceiptLevel = event.read?.watermark !== undefined ? "seen" : "delivered";
  const at = watermarkToDate(raw);
  return at ? { channel, recipientRef, level, at } : null;
}

/**
 * A WhatsApp status entry, if it is one we act on.
 *
 * `sent` is ignored: we already know we sent it — that is why there is a row. Only
 * the customer's side of the exchange is news. `failed` is not a receipt and is
 * deliberately not mapped to one; it gets its own treatment — whatsappFailure.
 */
export function whatsappReceipt(status: {
  status?: unknown;
  recipient_id?: unknown;
  timestamp?: unknown;
}): Receipt | null {
  const recipientRef = String(status.recipient_id ?? "").replace(/\D/g, "");
  if (!recipientRef) return null;
  const level: ReceiptLevel | null =
    status.status === "read" ? "seen" : status.status === "delivered" ? "delivered" : null;
  if (!level) return null;
  // WhatsApp timestamps are SECONDS since the epoch, unlike Meta's milliseconds.
  const seconds = Number(status.timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return { channel: "whatsapp", recipientRef, level, at: new Date(seconds * 1000) };
}

/**
 * A WhatsApp `failed` status: the message Meta ACCEPTED at send time and then
 * could not deliver (131047 = outside the 24-hour window is the common one).
 * The send already reported success, so this is the only place the failure
 * surfaces. Matched by `wamid` — exact, never a watermark, because a failure of
 * one message says nothing about its neighbours.
 */
export type WhatsAppFailure = { providerMessageId: string; failureCode: string; detail: string };

// Meta's async delivery error codes, onto the classes messageDelivery renders.
const WA_FAILURE_CODES: Record<number, string> = {
  131047: "outside_window",
  131026: "invalid_recipient",
  131049: "rejected_by_recipient",
  131050: "rejected_by_recipient",
  130429: "rate_limited",
  131048: "rate_limited",
  131056: "rate_limited",
};

export function whatsappFailure(status: {
  id?: unknown;
  status?: unknown;
  errors?: unknown;
}): WhatsAppFailure | null {
  if (status.status !== "failed") return null;
  const providerMessageId = typeof status.id === "string" ? status.id : "";
  if (!providerMessageId) return null;
  const first = (Array.isArray(status.errors) ? status.errors[0] : null) as { code?: unknown; title?: unknown } | null;
  const code = Number(first?.code);
  const title = typeof first?.title === "string" ? first.title.slice(0, 200) : "";
  // Code + Meta's generic title only. `error_data.details` can quote the
  // recipient, and this lands in lastError.
  const detail = [Number.isFinite(code) ? code : null, title || "WhatsApp could not deliver this message"].filter(Boolean).join(" ");
  return { providerMessageId, failureCode: WA_FAILURE_CODES[code] ?? "provider_error", detail };
}

/** The outcome of one POST /messages. `providerMessageId` is the wamid. */
export type WhatsAppSendResult = { ok: boolean; error?: string; providerMessageId?: string };

/** Graph's reply to a send, as a result. Pure so the wamid capture is testable. */
export function whatsappSendResult(res: { ok: boolean; status: number }, json: unknown): WhatsAppSendResult {
  const body = json as { error?: { message?: unknown }; messages?: Array<{ id?: unknown }> } | null;
  if (!res.ok) {
    const message = body?.error?.message;
    return { ok: false, error: typeof message === "string" ? message : `WhatsApp API error ${res.status}` };
  }
  const id = body?.messages?.[0]?.id;
  return typeof id === "string" && id ? { ok: true, providerMessageId: id } : { ok: true };
}

/**
 * A fetch that threw (timeout, DNS, TLS, reset) as a failed send, in the words
 * the customer timeline already uses (#694). "could not reach" classifies as
 * transient_network in classifyDeliveryFailure, so the outbox retries it.
 */
export function whatsappTransportFailure(error: unknown): WhatsAppSendResult {
  const name = error instanceof Error ? error.name : "Error";
  return { ok: false, error: `Could not reach WhatsApp (${name === "TimeoutError" || name === "AbortError" ? "timed out" : name})` };
}

function watermarkToDate(raw: unknown): Date | null {
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Which columns a receipt sets.
 *
 * Seen implies delivered. A conversation opened on a phone that was offline when
 * the message arrived can produce a `read` with no preceding `delivery`, and a UI
 * showing "Seen" above an empty "Delivered" would look broken. Both are stamped
 * with the same moment, which is the most that is actually known.
 */
export function receiptFields(level: ReceiptLevel, at: Date): { deliveredAt: Date; seenAt?: Date } {
  return level === "seen" ? { deliveredAt: at, seenAt: at } : { deliveredAt: at };
}

/**
 * What to show under an outbound bubble.
 *
 * Null for inbound — a receipt is about what the CUSTOMER did with our message,
 * and labelling their own message "Sent" is noise. Null also for a channel that
 * reports nothing, rather than showing "Sent" forever and implying we are still
 * waiting on a receipt that will never come.
 */
export function receiptLabel(
  message: { direction: string | null; deliveredAt?: Date | null; seenAt?: Date | null },
  channelReports: boolean,
): "Seen" | "Delivered" | "Sent" | null {
  if (message.direction !== "outbound") return null;
  if (message.seenAt) return "Seen";
  if (message.deliveredAt) return "Delivered";
  return channelReports ? "Sent" : null;
}

/** Channels that send delivery events at all. */
export const RECEIPT_CHANNELS = new Set(["messenger", "instagram", "whatsapp"]);
