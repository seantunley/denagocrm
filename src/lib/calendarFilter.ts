/**
 * The sales calendar's default view: appointments and blocked time only.
 * Calls, emails, follow-ups and to-dos are hidden until a type is picked
 * (or "All activities").
 */
export const CALENDAR_DEFAULT_VIEW = "default";

const DEFAULT_TYPES = new Set(["meeting", "test_drive"]);

export function inDefaultCalendarView(event: { type: string; availabilityBlock: boolean }): boolean {
  return event.availabilityBlock || DEFAULT_TYPES.has(event.type);
}
