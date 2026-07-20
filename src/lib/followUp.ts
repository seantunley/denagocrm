/**
 * Pure, DB-free helpers for the "Follow-up" activity type — a scheduled
 * check-back for when a customer says "I'll get back to you". Kept free of
 * Prisma/side-effect imports so the logic is unit-testable in isolation and
 * safe to import from both server actions and automation code.
 */

/** The activity `type` value for a scheduled customer follow-up. */
export const FOLLOW_UP_TYPE = "follow_up";

/**
 * Fallback hour-of-day (SAST) used when a follow-up is somehow saved without a
 * real time. Kept as a local constant so this module has no side-effect/DB
 * dependency; the creation UI always collects an explicit time anyway.
 */
export const DEFAULT_FOLLOW_UP_HOUR = 9;

/**
 * True when an activity is a follow-up that is still OPEN (status "planned")
 * and whose due date is still in the FUTURE. While such a follow-up exists on a
 * lead we suppress the "lead has gone quiet" nudge for that lead — the rep has
 * an explicit check-back scheduled, so the lead is not really quiet.
 */
export function isOpenFutureFollowUp(
  activity: { type: string; status: string; dueDate: Date },
  now: Date = new Date(),
): boolean {
  return (
    activity.type === FOLLOW_UP_TYPE &&
    activity.status === "planned" &&
    activity.dueDate.getTime() > now.getTime()
  );
}

/**
 * Normalises a datetime-local (or date-only) string so a follow-up always has a
 * REAL time of day rather than midnight. The hour-before reminder push in
 * `activityReminders` deliberately skips activities due at exactly 00:00, so a
 * date-only follow-up would never nudge the assignee. When no usable time is
 * present we fall back to the configured business-hours default hour.
 *
 * Returns a "YYYY-MM-DDTHH:MM" string, or null when there is no date at all.
 */
export function ensureFollowUpTime(
  rawDue: string | null,
  defaultHour: number = DEFAULT_FOLLOW_UP_HOUR,
): string | null {
  if (!rawDue) return null;
  const datePart = rawDue.slice(0, 10);
  if (datePart.length !== 10) return null;
  const timePart = rawDue.includes("T") ? rawDue.slice(11, 16) : "";
  if (!timePart || timePart === "00:00") {
    const safeHour = Math.max(0, Math.min(23, Math.trunc(defaultHour)));
    const hh = String(safeHour).padStart(2, "0");
    return `${datePart}T${hh}:00`;
  }
  return `${datePart}T${timePart}`;
}

/**
 * Validates a follow-up's user input: a note is REQUIRED (capture what the
 * customer said) and the due date must be a valid moment in the FUTURE. Returns
 * a human-readable error message, or null when the follow-up is valid.
 */
export function followUpValidationError(
  input: { note: string | null; dueDate: Date | null },
  now: Date = new Date(),
): string | null {
  if (!input.note || !input.note.trim()) {
    return "A follow-up needs a note — capture what the customer said they'd get back to you about.";
  }
  if (!input.dueDate || isNaN(input.dueDate.getTime())) {
    return "A follow-up needs a valid future date and time.";
  }
  if (input.dueDate.getTime() <= now.getTime()) {
    return "A follow-up must be scheduled for a future date and time.";
  }
  return null;
}
