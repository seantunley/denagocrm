import { z } from "zod";

/**
 * The CRM assistant's PLAN step — pure, so it can be tested without ChatGPT.
 *
 * The model never writes SQL and never reaches the database. It picks ONE of a
 * fixed set of read-only tools and fills in filter values; this schema is the
 * whole of what it can ask for. The server then runs that tool as the signed-in
 * user (their workspace, their record visibility) and hands the rows back for
 * the answer. Anything that doesn't validate is refused, not guessed at.
 */

const name = z.string().trim().min(1).max(80);
const days = z.number().int().min(1).max(365);
const rands = z.number().nonnegative().max(1_000_000_000);
const limit = z.number().int().min(1).max(25);

export const leadArgs = z
  .object({
    status: z.enum(["open", "won", "lost"]).optional(),
    stage: name.optional(),
    assignedTo: name.optional(),
    product: name.optional(),
    source: name.optional(),
    minValue: rands.optional(),
    /** No message, call or completed activity on the lead for this many days. */
    noContactDays: days.optional(),
    createdWithinDays: days.optional(),
    search: name.optional(),
    sort: z.enum(["value", "oldest_contact", "newest", "stage_age"]).optional(),
    limit: limit.optional(),
  })
  .strict();

export const quoteArgs = z
  .object({
    status: z.enum(["draft", "sent", "accepted", "declined", "cancelled"]).optional(),
    /** Sent, not yet signed, declined or cancelled. */
    awaitingSignature: z.boolean().optional(),
    viewed: z.boolean().optional(),
    minValue: rands.optional(),
    olderThanDays: days.optional(),
    limit: limit.optional(),
  })
  .strict();

export const activityArgs = z
  .object({
    when: z.enum(["overdue", "today", "this_week", "upcoming"]),
    type: name.optional(),
    assignedTo: name.optional(),
    limit: limit.optional(),
  })
  .strict();

export const assistantPlan = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("find_leads"), args: leadArgs.default({}) }),
  z.object({ tool: z.literal("pipeline_summary"), args: z.object({}).strict().default({}) }),
  z.object({ tool: z.literal("find_quotes"), args: quoteArgs.default({}) }),
  z.object({ tool: z.literal("find_activities"), args: activityArgs }),
  z.object({ tool: z.literal("none"), reply: z.string().trim().min(1).max(600) }),
]);

export type AssistantPlan = z.infer<typeof assistantPlan>;

/** What the plan step knows about this workspace, so names map to real values. */
export type PlanContext = {
  today: string; // YYYY-MM-DD, Johannesburg
  userName: string;
  stages: string[];
  staff: string[];
  activityTypes: string[];
};

export function planInstructions(ctx: PlanContext): string {
  return [
    "You turn a question about a sales CRM into ONE JSON tool call. Output JSON only — no prose, no code fence.",
    `Today is ${ctx.today} (South Africa). The person asking is ${ctx.userName}; "me"/"my"/"I" means them.`,
    "Tools (args are all optional unless marked):",
    '- find_leads: {"status":"open|won|lost","stage":"<stage>","assignedTo":"<person>","product":"<text>","source":"<text>","minValue":<rands>,"noContactDays":<days since any message, call or completed activity>,"createdWithinDays":<days>,"search":"<customer or lead name>","sort":"value|oldest_contact|newest|stage_age","limit":<1-25>}',
    '- pipeline_summary: {} — open leads counted and valued per stage.',
    '- find_quotes: {"status":"draft|sent|accepted|declined|cancelled","awaitingSignature":true,"viewed":true|false,"minValue":<rands>,"olderThanDays":<days>,"limit":<1-25>}',
    '- find_activities: {"when":"overdue|today|this_week|upcoming" (required),"type":"<type>","assignedTo":"<person>","limit":<1-25>}',
    '- none: {"reply":"<short answer>"} — only when no tool can answer (greetings, or something the CRM does not hold). Never invent CRM data.',
    `Stages: ${ctx.stages.join(", ") || "(none)"}.`,
    `People: ${ctx.staff.join(", ") || "(none)"}.`,
    `Activity types: ${ctx.activityTypes.join(", ") || "(none)"}.`,
    'Use names exactly as listed. Money is in rands (R200k = 200000). "Hot" or "biggest" → sort by value; "gone quiet"/"not contacted" → noContactDays.',
    'Shape: {"tool":"find_leads","args":{...}}',
  ].join("\n");
}

/**
 * The model's reply → a validated plan, or null. Tolerates a code fence or a
 * sentence around the object (models add them despite being told not to), but
 * nothing outside the schema survives.
 */
export function parsePlan(text: string): AssistantPlan | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = assistantPlan.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export const ANSWER_INSTRUCTIONS = [
  "You answer a question about a sales CRM using ONLY the JSON rows provided, which the CRM returned for this question.",
  "Be brief and concrete: lead with the answer, then at most a short list (name — the one or two facts that matter).",
  "Money is South African rand. If there are no rows, say so plainly. Never add records, figures or names that are not in the rows.",
  "If the rows were capped (truncated: true), say these are the top results, not all of them.",
  "Plain text only, no markdown tables.",
].join("\n");
