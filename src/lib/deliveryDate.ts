/**
 * The deliveries board's day, written out for a customer message — "Saturday, 14 November 2026".
 *
 * Read in UTC because the board stores the chosen calendar day at midnight UTC (`new Date("2026-11-14")`); in any
 * other zone west of UTC the same instant is the day before. Pure, so a test can hold it to the board.
 */
export function deliveryDateText(day: Date): string {
  return day.toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** The board's day as stored ("2026-11-14"), or null when no delivery is scheduled. */
export const deliveryDay = (scheduledFor: Date | null | undefined): string | null => scheduledFor?.toISOString().slice(0, 10) ?? null;

/**
 * Why a "Delivery is scheduled or moved" run must not take its next step (review of #1044), or null when it may.
 *
 * A run carries the scheduling CHANGE that started it (`changeId`). If the delivery has been scheduled again since
 * — even back to the same day, 14th → 16th → 14th — a newer run speaks for it, and a message this one is still
 * waiting to send could announce an outdated day or repeat the newer run's. So it stops. Runs of any other
 * trigger are never stale here.
 */
export function staleDeliveryRunReason(
  event: Record<string, unknown> | null | undefined,
  /** The quote now: its delivery day (deliveryDay) and the latest change's id; undefined when the quote is gone. */
  current: { day: string | null; latestChangeId: string | null } | undefined,
): string | null {
  if (event?.type !== "delivery_scheduled" || typeof event.changeId !== "string") return null;
  if (current === undefined) return "The quote this delivery was for is gone — nothing sent";
  if (current.day === null) return "The delivery is no longer scheduled — nothing sent";
  // The DAY too, not only the change (review of #1044): the board writes the new day before the new event is
  // recorded, so for a moment this run is still "the latest change" while the quote already says another day.
  if (current.day === event.deliveryDate && current.latestChangeId === event.changeId) return null;
  return `The delivery was scheduled again (now ${deliveryDateText(new Date(current.day))}) — a newer run speaks for it, so this one stops`;
}
