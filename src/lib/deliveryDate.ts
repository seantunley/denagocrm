/**
 * The deliveries board's day, written out for a customer message — "Saturday, 14 November 2026".
 *
 * Read in UTC because the board stores the chosen calendar day at midnight UTC (`new Date("2026-11-14")`); in any
 * other zone west of UTC the same instant is the day before. Pure, so a test can hold it to the board.
 */
export function deliveryDateText(day: Date): string {
  return day.toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
