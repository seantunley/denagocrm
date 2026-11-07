/**
 * The phone's Capture sheet (components/CaptureSheet.tsx): what it records
 * against, and when the "Next step" it offers falls due. Pure, so the choices a
 * rep makes with a thumb in the yard are tested without a browser.
 */

/** A record the sheet can file against. Loaded by actions/capture.ts; typed here so a client can import it. */
export type CaptureRecord = {
  type: "lead" | "contact";
  id: string;
  label: string;
  sublabel: string;
  /** The number WhatsApp opens — the lead's own, else its customer's WhatsApp, else their phone. */
  phone: string | null;
  leadId: string | null;
  contactId: string | null;
};

export type CaptureTargetRef = Pick<CaptureRecord, "type" | "id">;

/**
 * Pages under /leads and /contacts whose second segment is a page, not a record
 * id — the same words lib/phoneScope.ts and the route folders use.
 */
const NOT_RECORD_IDS = new Set(["new", "nurture", "attention", "closed", "list", "import", "board", "trash", "insights", "merge"]);

/**
 * Which record the sheet opens on, from the page the person is looking at:
 * `/leads/:id` (and anything under it) is that lead, `/contacts/:id` that
 * customer. Anywhere else the sheet asks.
 */
export function captureTargetFromPath(pathname: string): CaptureTargetRef | null {
  const [root, id] = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (!id || NOT_RECORD_IDS.has(id)) return null;
  if (root === "leads") return { type: "lead", id };
  if (root === "contacts") return { type: "contact", id };
  return null;
}

export const NEXT_STEP_WHEN = [
  { key: "tomorrow", label: "Tomorrow", days: 1 },
  { key: "2days", label: "2 days", days: 2 },
  { key: "1week", label: "1 week", days: 7 },
] as const;
export type NextStepWhen = (typeof NEXT_STEP_WHEN)[number]["key"];

export const NEXT_STEP_KINDS = [
  { key: "call", label: "Call" },
  { key: "meeting", label: "Meeting" },
  { key: "todo", label: "Task" },
] as const;
export type NextStepKind = (typeof NEXT_STEP_KINDS)[number]["key"];

/** Working hours start; a follow-up "tomorrow" is for the morning, not for this minute tomorrow. */
const NEXT_STEP_HOUR = 9;

/**
 * When a chip falls due, as the `datetime-local` string scheduleFollowUp takes
 * (`YYYY-MM-DDTHH:mm`, read as South African time by the action). Counted in
 * the device's calendar days, so "tomorrow" late on a Friday is Saturday 09:00,
 * never a time arithmetic lands in the small hours.
 */
export function nextStepDue(when: NextStepWhen, now: Date): string {
  const days = NEXT_STEP_WHEN.find((chip) => chip.key === when)?.days ?? 1;
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, NEXT_STEP_HOUR, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}T${pad(NEXT_STEP_HOUR)}:00`;
}

/**
 * The wa.me address for a stored number: digits only, a local leading 0 made
 * South Africa's country code — exactly what WhatsAppPanel's link does, kept in
 * one place now that two screens build it. Null for a number with no digits.
 */
export function waMeLink(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "").replace(/^0/, "27");
  return digits ? `https://wa.me/${digits}` : null;
}
