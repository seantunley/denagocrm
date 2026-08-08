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
 * still applied as a watermark here, for one reason — nothing on the send path
 * records the platform's message id. `sendWhatsAppText` and `sendDirectMessage`
 * both discard the response body, so there is no id to match against, and
 * threading one through every send and every recording call site is a larger
 * change than this feature needs. The inference is sound either way: WhatsApp
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
 * deliberately not mapped to one; a failure needs its own treatment rather than
 * being recorded as a quieter kind of success.
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
