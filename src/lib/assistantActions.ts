import { z } from "zod";
import { scheduleFields, type Cadence } from "./assistantSchedule";
import { watchFields, type WatchInput } from "./assistantWatchRules";

/**
 * Tasks the assistant can PROPOSE — never perform. It drafts; the person sees a
 * card and presses Confirm (or Send), and only then does the matching existing
 * server action run (scheduleFollowUp, scheduleActivity, createTestDriveBooking,
 * rescheduleActivity, cancelActivity, addCommunication, assignLead, moveLead,
 * markLost, createQuoteFromLead, and the lead page's own message box), with
 * that person's own permissions, the stage gates, the clash checks and the
 * audit log, exactly as if they had done it by hand. A scheduled question is
 * saved for the signed-in person only, and later runs as them.
 *
 * A message to a customer goes out only when the person presses Send on its
 * card, after reading (and if they like, editing) it. The assistant never sends
 * anything on its own (definition of done: no send without an explicit click).
 */

const leadId = z.string().trim().min(10).max(40);
const activityId = z.string().trim().min(10).max(40);
const text = z.string().trim().min(1);
const at = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/);
const atTime = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const minutes = z.number().int().min(15).max(480);
const reason = z.string().trim().min(3).max(160).optional();

export const proposedAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("follow_up"),
    leadId,
    when: at,
    activity: z.enum(["call", "whatsapp", "email", "meeting", "todo"]).default("call"),
    summary: text.max(120).optional(),
    reason,
  }).strict(),
  z.object({ type: z.literal("note"), leadId, text: text.max(2000), reason }).strict(),
  z.object({ type: z.literal("assign"), leadId, to: text.max(80), reason }).strict(),
  z.object({ type: z.literal("stage"), leadId, stage: text.max(80), reason }).strict(),
  z.object({
    type: z.literal("draft_message"),
    leadId,
    channel: z.enum(["whatsapp", "email"]),
    subject: text.max(150).optional(),
    body: text.max(2000),
    reason,
  }).strict(),
  // A meeting at a set time, with colleagues — through the calendar's own
  // booking, so a clash with anyone's diary is refused there.
  z.object({
    type: z.literal("meeting"),
    leadId,
    when: atTime,
    minutes: minutes.optional(),
    with: z.array(text.max(80)).max(5).optional(),
    summary: text.max(120).optional(),
    reason,
  }).strict(),
  z.object({ type: z.literal("test_drive"), leadId, when: atTime, minutes: minutes.optional(), vehicle: text.max(80), reason }).strict(),
  z.object({ type: z.literal("reschedule"), activityId, when: at, reason }).strict(),
  z.object({ type: z.literal("cancel_activity"), activityId, reason }).strict(),
  z.object({ type: z.literal("lost"), leadId, reason: text.max(300) }).strict(),
  z.object({ type: z.literal("quote"), leadId, reason }).strict(),
  // A question to run later, as the person — no lead: it names its own subject.
  // Cross-field rules (weekday only for weekly…) are checked by scheduleInput
  // when it becomes a card and again when it is saved.
  z.object({ type: z.literal("schedule"), ...scheduleFields, reason }).strict(),
  // "Tell me when…" — checked by fixed rules every half hour; it only ever
  // notifies the person who confirmed it (assistantWatch).
  z.object({ type: z.literal("watch"), ...watchFields, reason }).strict(),
]);
export type ProposedAction = z.infer<typeof proposedAction>;

export const MAX_ACTIONS = 4;

export const ACTION_INSTRUCTIONS = [
  "TASKS. You can't change anything yourself, but you can PROPOSE up to 4 tasks for the person to confirm with one click. Propose when they ask you to do something (\"remind me…\", \"give it to Donovan\", \"draft a message…\", \"book Anna a test drive\"), or offer one when you recommend a concrete next step.",
  'Put them under "actions" in the reply block:',
  '"actions":[{"type":"follow_up","leadId":"<id>","when":"YYYY-MM-DDTHH:MM","activity":"call|whatsapp|email|meeting|todo","summary":"...","reason":"why this helps"},{"type":"note","leadId":"<id>","text":"..."},{"type":"assign","leadId":"<id>","to":"<person>"},{"type":"stage","leadId":"<id>","stage":"<stage>"},{"type":"draft_message","leadId":"<id>","channel":"whatsapp|email","subject":"<email only>","body":"..."},{"type":"meeting","leadId":"<id>","when":"YYYY-MM-DDTHH:MM","minutes":60,"with":["<colleague>"],"summary":"..."},{"type":"test_drive","leadId":"<id>","when":"YYYY-MM-DDTHH:MM","minutes":60,"vehicle":"<demo vehicle name>"},{"type":"reschedule","activityId":"<id>","when":"YYYY-MM-DDTHH:MM"},{"type":"cancel_activity","activityId":"<id>"},{"type":"lost","leadId":"<id>","reason":"..."},{"type":"quote","leadId":"<id>"},{"type":"schedule","question":"...","cadence":"once|daily|weekdays|weekly","weekday":1,"timeOfDay":"HH:MM","onDate":"YYYY-MM-DD"},{"type":"watch","kind":"quote_viewed|quote_unsigned|lead_quiet|test_drive_no_follow_up|delivery_deposit_due","quoteId":"Q-1042","leadId":"<id>","product":"<product>","thresholdHours":48,"thresholdDays":3}]',
  "- Add a short \"reason\" (under 160 characters) on any proposal when you know why it helps — the card shows it so the person sees the point before confirming. Skip it when the title already says everything.",
  "- watch: when they say \"tell me when / let me know if\" something happens — quote_viewed (quoteId: the customer opens that quote), quote_unsigned (viewed but not signed after thresholdHours; one quoteId or all theirs), lead_quiet (no customer contact for thresholdDays; one leadId, or every open lead for a product), test_drive_no_follow_up (a test drive done thresholdHours ago with nothing planned next), delivery_deposit_due (delivery within thresholdHours and no deposit). Only the fields that kind uses. It only ever tells THEM — it never contacts a customer. Offer one yourself when it would help (\"I can tell you when Anna opens it\").",
  "- schedule: a question for you to answer on your own LATER or REPEATEDLY (\"every Monday at 7 tell me which deals went quiet\", \"Friday at 9, has Anna signed?\"). weekday (0 = Sunday … 6 = Saturday) only with weekly; onDate only with once. Schedules run on the hour or half past, so timeOfDay is always HH:00 or HH:30 — if they ask for 07:10, propose 07:00 and say it runs on the half hour. It runs later with no conversation, so the question must stand alone — name the customer or thing (\"Has Anna Jacobs signed her quote?\"), never \"her\" or \"that deal\". No leadId. A plain reminder to do something with a lead (\"remind me to call Anna Friday\") is a follow_up, not a schedule.",
  "- meeting / test_drive: check the calendar (schedule) and, for a test drive, the demo vehicle's bookings (vehicles kind demo) BEFORE proposing — never a slot that clashes. vehicle is the demo vehicle's name exactly as listed. reschedule / cancel_activity need an activity id from the results.",
  "- lost: only when the person says the deal is lost or asks you to close it; the reason in their words. quote: starts a draft quote on the lead for them to fill in — nothing is sent.",
  "- leadId and activityId must be ids that appear in the CRM results above — never invent one. If you don't have it, look the lead up first or don't propose.",
  "- People and stages exactly as listed. Times are South African time.",
  "- draft_message: write it in the business's voice, ready to send. The person reads it, can edit it, and sends it with their own click — it never goes out on its own.",
  "- In your answer, never say you did it — say you've set it up for them to confirm.",
].join("\n");

/** A list of proposals → the valid ones. Each stands alone: one malformed entry doesn't sink the others. */
export function parseActionList(raw: unknown): ProposedAction[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => proposedAction.safeParse(item))
    .filter((r) => r.success)
    .map((r) => r.data)
    .slice(0, MAX_ACTIONS);
}

/** LEGACY: pull an old-style ACTIONS line out of the reply (see assistantReply). */
export function splitActions(reply: string): { answer: string; actions: ProposedAction[] } {
  const lines = reply.trimEnd().split("\n");
  const at = lines.findLastIndex((line) => line.trim().startsWith("ACTIONS:"));
  if (at === -1) return { answer: reply.trim(), actions: [] };
  const answer = lines.filter((_, i) => i !== at).join("\n").trim();
  let raw: unknown;
  try {
    raw = JSON.parse(lines[at].trim().slice("ACTIONS:".length).trim());
  } catch {
    return { answer, actions: [] };
  }
  return { answer, actions: parseActionList(raw) };
}

/**
 * Quick replies. When it asks the person to pick ("Anna or Ben Jacobs?", "call
 * or WhatsApp?") the options come back as buttons; tapping one sends that text
 * as their next message — exactly as if they'd typed it, so nothing new is
 * trusted. Not stored: only the latest answer's choices are worth showing.
 */
export const MAX_CHOICES = 4;
const choices = z.array(z.unknown()).max(12);
const choice = z.string().trim().min(1).max(60);

export const CHOICE_INSTRUCTIONS = [
  'CHOICES. When you ask the person to pick between a few clear options (which customer, which time slot, call or WhatsApp), also put the options under "choices" in the reply block:',
  '"choices":["Anna Jacobs","Ben Jacobs"]',
  `- 2 to ${MAX_CHOICES} options, each worded as the person's own short reply (under 60 characters). They become buttons; tapping one sends it as the person's reply.`,
  "- Each option must tell the choices apart on its own — by what differs (stage, value, date, product, who owns it): \"Anna Jacobs — Quoted, R235k\", never \"The first one\". If the records are duplicates that can't be told apart, say so instead of offering buttons.",
  "- Still ask the question in your answer. No choices when you aren't asking them to choose, and not for confirming a proposed task — its card has its own Confirm.",
].join("\n");

/** A list of options → the valid ones (deduped, at most MAX_CHOICES; one option isn't a choice). */
export function parseChoiceList(raw: unknown): string[] {
  const list = choices.safeParse(raw);
  if (!list.success) return [];
  const valid = list.data.map((c) => choice.safeParse(c)).filter((r) => r.success).map((r) => r.data);
  const unique = [...new Set(valid)].slice(0, MAX_CHOICES);
  return unique.length >= 2 ? unique : [];
}

/** LEGACY: the reply → the answer without an old-style CHOICES line, and the valid options. */
export function splitChoices(reply: string): { answer: string; choices: string[] } {
  const lines = reply.trimEnd().split("\n");
  const at = lines.findLastIndex((line) => line.trim().startsWith("CHOICES:"));
  if (at === -1) return { answer: reply.trim(), choices: [] };
  const answer = lines.filter((_, i) => i !== at).join("\n").trim();
  let raw: unknown;
  try {
    raw = JSON.parse(lines[at].trim().slice("CHOICES:".length).trim());
  } catch {
    return { answer, choices: [] };
  }
  return { answer, choices: parseChoiceList(raw) };
}

/**
 * A proposal the server has checked and resolved (names → ids), ready for a card.
 *
 * STALE CARDS. A card can sit on screen while the record changes underneath
 * it — DAX proposes "move Anna to Quoted", someone else moves her to Won, then
 * Confirm is pressed. So a card that changes a record's state carries what it
 * expected to find (`from…`), and Confirm refuses when that's no longer true
 * rather than applying a suggestion made about a deal that has moved on.
 * Only the field the card changes is compared: a lead touched in some other
 * way (a note, being opened) doesn't make "give it to Donovan" wrong.
 */
type LeadCard = { id: string; leadId: string; leadLabel: string; title: string; reason?: string };
export const STALE_CARD = "This changed since DAX suggested it — ask again to see where it stands now.";
export type ActionCard =
  | (LeadCard & { kind: "follow_up"; when: string; activity: string; summary?: string })
  | (LeadCard & { kind: "note"; text: string })
  | (LeadCard & { kind: "assign"; userId: string; fromUserId: string | null })
  | (LeadCard & { kind: "stage"; stageId: string; fromStageId: string })
  | (LeadCard & { kind: "draft_message"; channel: "whatsapp" | "email"; subject?: string; body: string; to: string | null })
  | (LeadCard & { kind: "meeting"; start: string; end: string; summary: string; attendeeIds: string[]; detail: string })
  | (LeadCard & { kind: "test_drive"; contactId: string; demoVehicleId: string; branch: string; start: string; end: string; detail: string })
  | (LeadCard & { kind: "lost"; reason: string })
  | (LeadCard & { kind: "quote" })
  | { id: string; kind: "reschedule"; activityId: string; title: string; when: string; leadId: string | null; leadLabel: string; fromDue: string; reason?: string }
  | { id: string; kind: "cancel_activity"; activityId: string; title: string; leadId: string | null; leadLabel: string; fromDue: string; reason?: string }
  | { id: string; kind: "schedule"; title: string; question: string; cadence: Cadence; weekday?: number; timeOfDay: string; onDate?: string; reason?: string }
  | { id: string; kind: "watch"; title: string; watch: WatchInput; reason?: string };
