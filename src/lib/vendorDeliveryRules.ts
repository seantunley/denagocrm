/**
 * A delivery booked with a transport supplier (vendors plan step 2): its statuses, the day it is for, and the
 * message the supplier gets. Pure.
 */

export const DELIVERY_STATUS_LABELS = {
  requested: "Requested",
  confirmed: "Confirmed",
  collected: "Collected",
  delivered: "Delivered",
  cancelled: "Cancelled",
} as const;
export type DeliveryStatus = keyof typeof DELIVERY_STATUS_LABELS;

/** Where a booking can go from each status: forward one step, or cancelled until the cart is on the truck. */
const NEXT: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  requested: ["confirmed", "cancelled"],
  confirmed: ["collected", "cancelled"],
  collected: ["delivered"],
  delivered: [],
  cancelled: [],
};

export const nextDeliveryStatuses = (status: string): readonly DeliveryStatus[] => NEXT[status as DeliveryStatus] ?? [];
export const canMoveDelivery = (from: string, to: string): boolean => nextDeliveryStatuses(from).includes(to as DeliveryStatus);
export const deliveryStatusLabel = (status: string): string => DELIVERY_STATUS_LABELS[status as DeliveryStatus] ?? status;

/** "2026-11-14" → midnight UTC that day; null for anything that isn't a real calendar day. */
export function bookingDay(value: unknown): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === match[0] ? date : null;
}

export type BookingMessageInput = {
  brand: string;
  vendorName: string;
  /** "Q-1029" for a customer delivery; the order reference for stock coming in. */
  reference: string;
  /** "Thursday, 14 November 2026". */
  dayLabel: string;
  fromAddress: string;
  toAddress: string;
  /** What is being moved, one item per line. */
  items: string[];
  note: string | null;
};

/** The booking as the supplier reads it — by email or pasted into WhatsApp. Nothing about the customer but the address. */
export function bookingMessage(input: BookingMessageInput): { subject: string; text: string } {
  const lines = [
    `Hi ${input.vendorName},`,
    "",
    `${input.brand} would like to book a delivery (${input.reference}) for ${input.dayLabel}.`,
    "",
    `Collect from: ${input.fromAddress}`,
    `Deliver to: ${input.toAddress}`,
    ...(input.items.length ? ["", "What:", ...input.items.map((item) => `- ${item}`)] : []),
    ...(input.note ? ["", input.note] : []),
    "",
    "Please confirm you can do it.",
    "",
    "Thank you,",
    input.brand,
  ];
  return { subject: `Delivery booking ${input.reference} — ${input.dayLabel}`, text: lines.join("\n") };
}
