import { z } from "zod";
import { scheduleFields, type Cadence } from "./assistantSchedule";

/**
 * Tasks the assistant can PROPOSE — never perform. It drafts; the person sees a
 * card and presses Confirm, and only then does the matching existing server
 * action run (scheduleFollowUp, addCommunication, assignLead, moveLead), with
 * that person's own permissions, the stage gates and the audit log, exactly as
 * if they had done it by hand. A scheduled question is saved for the signed-in
 * person only, and later runs as them. A message to a customer is only ever a draft to
 * copy into the conversation: the assistant never sends anything (definition of
 * done: no send without an explicit click).
 */

const leadId = z.string().trim().min(10).max(40);
const text = z.string().trim().min(1);

export const proposedAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("follow_up"),
    leadId,
    when: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/),
    activity: z.enum(["call", "whatsapp", "email", "meeting", "todo"]).default("call"),
    summary: text.max(120).optional(),
  }).strict(),
  z.object({ type: z.literal("note"), leadId, text: text.max(2000) }).strict(),
  z.object({ type: z.literal("assign"), leadId, to: text.max(80) }).strict(),
  z.object({ type: z.literal("stage"), leadId, stage: text.max(80) }).strict(),
  z.object({
    type: z.literal("draft_message"),
    leadId,
    channel: z.enum(["whatsapp", "email"]),
    subject: text.max(150).optional(),
    body: text.max(2000),
  }).strict(),
  // A question to run later, as the person — no lead: it names its own subject.
  // Cross-field rules (weekday only for weekly…) are checked by scheduleInput
  // when it becomes a card and again when it is saved.
  z.object({ type: z.literal("schedule"), ...scheduleFields }).strict(),
]);
export type ProposedAction = z.infer<typeof proposedAction>;

export const MAX_ACTIONS = 4;

export const ACTION_INSTRUCTIONS = [
  "TASKS. You can't change anything yourself, but you can PROPOSE up to 4 tasks for the person to confirm with one click. Propose when they ask you to do something (\"remind me…\", \"give it to Donovan\", \"draft a message…\"), or offer one when you recommend a concrete next step.",
  "Put them on one line at the very end (after any LEARN line is fine):",
  'ACTIONS: [{"type":"follow_up","leadId":"<id>","when":"YYYY-MM-DDTHH:MM","activity":"call|whatsapp|email|meeting|todo","summary":"..."},{"type":"note","leadId":"<id>","text":"..."},{"type":"assign","leadId":"<id>","to":"<person>"},{"type":"stage","leadId":"<id>","stage":"<stage>"},{"type":"draft_message","leadId":"<id>","channel":"whatsapp|email","subject":"<email only>","body":"..."},{"type":"schedule","question":"...","cadence":"once|daily|weekdays|weekly","weekday":1,"timeOfDay":"HH:MM","onDate":"YYYY-MM-DD"}]',
  "- schedule: a question for you to answer on your own LATER or REPEATEDLY (\"every Monday at 7 tell me which deals went quiet\", \"Friday at 9, has Anna signed?\"). weekday (0 = Sunday … 6 = Saturday) only with weekly; onDate only with once. Schedules run on the hour or half past, so timeOfDay is always HH:00 or HH:30 — if they ask for 07:10, propose 07:00 and say it runs on the half hour. It runs later with no conversation, so the question must stand alone — name the customer or thing (\"Has Anna Jacobs signed her quote?\"), never \"her\" or \"that deal\". No leadId. A plain reminder to do something with a lead (\"remind me to call Anna Friday\") is a follow_up, not a schedule.",
  "- leadId must be an id that appears in the CRM results above — never invent one. If you don't have it, look the lead up first or don't propose.",
  "- People and stages exactly as listed. Times are South African time.",
  "- draft_message: write it in the business's voice, ready to send; it is only a draft the person copies and sends themselves.",
  "- In your answer, never say you did it — say you've set it up for them to confirm.",
].join("\n");

/** Pull the ACTIONS line out of the reply: what the person reads, and the valid proposals. */
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
  if (!Array.isArray(raw)) return { answer, actions: [] };
  // Each proposal stands alone: one malformed entry doesn't sink the others.
  const actions = raw
    .map((item) => proposedAction.safeParse(item))
    .filter((r) => r.success)
    .map((r) => r.data)
    .slice(0, MAX_ACTIONS);
  return { answer, actions };
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
  "CHOICES. When you ask the person to pick between a few clear options (which customer, which time slot, call or WhatsApp), also put the options on one line at the very end:",
  'CHOICES: ["Anna Jacobs","Ben Jacobs"]',
  `- 2 to ${MAX_CHOICES} options, each worded as the person's own short reply (under 60 characters). They become buttons; tapping one sends it as the person's reply.`,
  "- Still ask the question in your answer. No CHOICES line when you aren't asking them to choose, and not for confirming a proposed task — its card has its own Confirm.",
].join("\n");

/** The reply → the answer without its CHOICES line, and the valid options (deduped, at most MAX_CHOICES). */
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
  const list = choices.safeParse(raw);
  if (!list.success) return { answer, choices: [] };
  const valid = list.data.map((c) => choice.safeParse(c)).filter((r) => r.success).map((r) => r.data);
  const unique = [...new Set(valid)].slice(0, MAX_CHOICES);
  // One option isn't a choice.
  return { answer, choices: unique.length >= 2 ? unique : [] };
}

/** A proposal the server has checked and resolved (names → ids), ready for a card. */
export type ActionCard =
  | { id: string; kind: "follow_up"; leadId: string; leadLabel: string; title: string; when: string; activity: string; summary?: string }
  | { id: string; kind: "note"; leadId: string; leadLabel: string; title: string; text: string }
  | { id: string; kind: "assign"; leadId: string; leadLabel: string; title: string; userId: string }
  | { id: string; kind: "stage"; leadId: string; leadLabel: string; title: string; stageId: string }
  | { id: string; kind: "draft_message"; leadId: string; leadLabel: string; title: string; channel: "whatsapp" | "email"; subject?: string; body: string }
  | { id: string; kind: "schedule"; title: string; question: string; cadence: Cadence; weekday?: number; timeOfDay: string; onDate?: string };
