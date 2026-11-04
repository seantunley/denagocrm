/**
 * SHARED VALUES (Node-RED's context / environment variables; Sean, 2026-11-04): set once on Flows → Shared values —
 * `business_phone`, `opening_hours`, `website` — and use them as {{business_phone}} in any message of any flow, so a
 * phone-number change is one edit. Read fresh on every turn (no republish), never secret (shown on the page), and
 * read-only to a flow: a name can't be one the engine already fills in, and a flow can't save an answer over one.
 */
export const FLOW_SHARED_VALUES_KEY = "FLOW_SHARED_VALUES";
export const SHARED_VALUE_LIMIT = 40;
export const SHARED_NAME = /^[a-z][a-z0-9_]{1,39}$/;

/** Names the engine fills in itself (flowValidation BUILTIN_VARS + runtime) — a shared value can't take one. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "greeting", "first_name", "name", "known", "slot", "channel", "current_date", "current_time",
  "booking_identity", "booking_found", "booking_id", "booking_slot", "booking_summary", "booking_cancelled", "booking_rescheduled",
  "journey_started", "journey_reason", "journey_run_id", "open_now", "phone", "email",
]);

export type SharedValue = { name: string; value: string };

export function parseSharedValues(raw: string | null | undefined): SharedValue[] {
  try {
    const list = JSON.parse(raw ?? "[]");
    if (!Array.isArray(list)) return [];
    return list
      .filter((v): v is SharedValue => Boolean(v) && typeof v.name === "string" && typeof v.value === "string" && SHARED_NAME.test(v.name) && !RESERVED_NAMES.has(v.name))
      .slice(0, SHARED_VALUE_LIMIT);
  } catch {
    return [];
  }
}

/** As flow variables: { business_phone: "021 555 0100", … }. */
export const sharedVars = (list: SharedValue[]): Record<string, string> => Object.fromEntries(list.map((v) => [v.name, v.value]));

/** Why a name can't be used, or null. */
export function sharedNameProblem(name: string, taken: string[] = []): string | null {
  if (!SHARED_NAME.test(name)) return "Use lowercase letters, numbers and _ only, starting with a letter — e.g. business_phone.";
  if (RESERVED_NAMES.has(name)) return `{{${name}}} is filled in by the chatbot itself — choose another name.`;
  if (taken.includes(name)) return `There is already a shared value called ${name}.`;
  return null;
}
