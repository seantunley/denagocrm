import { z } from "zod";
import { proposedAction, type ActionCard, type ProposedAction } from "./assistantActions";
import { stripInvisible } from "./invisibleText";

/**
 * MULTI-STEP PLANS (roadmap Phase 3, 2026-10-26) — the pure half; the database
 * half is assistantPlan.ts.
 *
 * "Quote Werner, send me the PDF, draft the email and remind me Friday" becomes
 * ONE card listing the steps. One Confirm runs the INTERNAL steps in order, each
 * through the same server action its own card uses (runAssistantAction), so
 * every permission check, stage gate and clash check applies unchanged. The
 * customer email is never part of it: it stays its own card with its own Send
 * (Sean, 2026-10-26 — there is no "runs with no click" setting).
 *
 * A plan stops at the first step that fails or is refused, and shows what ran
 * and what didn't. Retry carries on from that step; a step already done is
 * never run again (its claim row, below), and a quote step carries its own
 * confirm key, so a Retry never makes a second quote.
 */

/** The most steps one plan may hold. Loose cards keep their cap of 4 (MAX_ACTIONS). */
export const PLAN_MAX_STEPS = 8;

/** A message to a customer: never run by a plan — it stays its own card with a Send button. */
export const SEND_KINDS: ReadonlySet<string> = new Set(["draft_message"]);

/**
 * Steps that may be tried again after failing part-way: their own action spends
 * a confirm key in the transaction that does the work, so a second run finds it
 * and does nothing twice. Any other step that failed in an unknown way is not
 * re-run — retrying an unknown is how a note gets written twice.
 */
export const RETRY_SAFE_KINDS: ReadonlySet<string> = new Set(["quote_build", "quote_add", "quote_change", "job_card"]);

/** A claim older than this with no outcome was interrupted (the request died part-way). */
export const STEP_STALE_MS = 10 * 60 * 1000;

export type PlanStepStatus = "waiting" | "running" | "done" | "refused" | "failed";
export type PlanStep = {
  n: number;
  /** The claim row's id (an AssistantPendingAction): one per step, so a finished step is never run again. */
  key: string;
  title: string;
  card: ActionCard;
  /** This step works on the quote that step `fromStep` made (the quote number from quote_build feeds quote_pdf). */
  fromStep?: number;
  status: PlanStepStatus;
  message?: string;
  href?: string;
  quote?: { id: string; number: number };
};
/** Stored on the plan's AssistantTask row, in `details.plan`. */
export type PlanState = { v: 1; expiresAt: string; steps: PlanStep[]; sends: string[] };

export type PlanStatus = "waiting" | "running" | "paused" | "done" | "expired" | "closed";
/** What the person sees: on the card in the chat, and on the Ask page. */
export type PlanView = {
  taskId: string;
  title: string;
  status: PlanStatus;
  /** "Paused at step 3 — …", "Done", … */
  summary: string;
  steps: { n: number; title: string; status: PlanStepStatus; message?: string; href?: string }[];
  /** Customer messages from the same request: each is its own Send card, never run by the plan. */
  sends: string[];
  quoteId: string | null;
  /** Retry (or Confirm) is offered. */
  canRun: boolean;
};

/* ── The model's proposal ─────────────────────────────────────────────────── */

/** A step is any task but a check-back (DAX's own reminder, never confirmed). */
type StepAction = Exclude<ProposedAction, { type: "check_back" }>;
export type PlanProposal = { title: string; steps: { action: StepAction; dependsOn?: number }[]; dropped: number };

/** Stands in for a quote that an earlier step of the plan will make. */
export const LATER_QUOTE = "the quote an earlier step makes";
const planBlock = z.object({ title: z.string().max(500).optional(), steps: z.array(z.unknown()).max(20) }).passthrough();

/**
 * The reply block's "plan" → a cleaned proposal, or null. Each step is a task
 * exactly as in "actions" plus an optional `dependsOn` (1-based, an EARLIER
 * step). A malformed step is dropped, and so is any step that depends on it.
 */
export function parsePlan(raw: unknown): PlanProposal | null {
  const parsed = planBlock.safeParse(raw);
  if (!parsed.success) return null;
  const kept: { action: StepAction; dependsOn?: number; from: number }[] = [];
  let dropped = 0;
  parsed.data.steps.slice(0, PLAN_MAX_STEPS).forEach((rawStep, at) => {
    const { dependsOn, ...rest } = rawStep && typeof rawStep === "object" ? (rawStep as Record<string, unknown>) : { dependsOn: undefined };
    // The PDF of a quote an earlier step makes has no number yet: the runner fills it in (cardForStep).
    if (rest.type === "quote_pdf" && dependsOn !== undefined && rest.quote === undefined) rest.quote = LATER_QUOTE;
    const action = proposedAction.safeParse(rest);
    const dep = typeof dependsOn === "number" && Number.isInteger(dependsOn) && dependsOn >= 1 && dependsOn <= at ? dependsOn : undefined;
    const depKept = dep === undefined || kept.some((s) => s.from === dep);
    if (!action.success || action.data.type === "check_back" || (dependsOn !== undefined && dep === undefined) || !depKept) {
      dropped++;
      return;
    }
    kept.push({ action: action.data, ...(dep ? { dependsOn: dep } : {}), from: at + 1 });
  });
  dropped += Math.max(0, parsed.data.steps.length - PLAN_MAX_STEPS);
  // Renumber: dependsOn named the ORIGINAL positions.
  const position = new Map(kept.map((s, i) => [s.from, i + 1]));
  const steps = kept.map(({ action, dependsOn }) => ({ action, ...(dependsOn ? { dependsOn: position.get(dependsOn)! } : {}) }));
  if (!steps.length) return null;
  const title = stripInvisible(parsed.data.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "Plan";
  return { title, steps, dropped };
}

/* ── Running it ───────────────────────────────────────────────────────────── */

/** Stored JSON → the plan, or null when it is not one. */
export function readPlan(details: unknown): PlanState | null {
  const plan = details && typeof details === "object" ? (details as { plan?: unknown }).plan : null;
  if (!plan || typeof plan !== "object") return null;
  const p = plan as Partial<PlanState>;
  return p.v === 1 && Array.isArray(p.steps) && typeof p.expiresAt === "string" ? { v: 1, expiresAt: p.expiresAt, steps: p.steps, sends: Array.isArray(p.sends) ? p.sends : [] } : null;
}

/** The step to run next: the first not done. Null when every step is done. */
export const nextStep = (plan: PlanState): PlanStep | null => plan.steps.find((s) => s.status !== "done") ?? null;

/**
 * The card a step runs, with what an earlier step made filled in. A quote_pdf for
 * a quote the plan itself built names that quote; a "watch" on it names it too.
 * Null when the step it depends on left nothing to work on.
 */
export function cardForStep(plan: PlanState, step: PlanStep): ActionCard | null {
  if (!step.fromStep) return step.card;
  const quote = plan.steps[step.fromStep - 1]?.quote;
  if (!quote) return null;
  const card = step.card;
  if (card.kind === "quote_pdf") return { ...card, quoteId: quote.id, quoteNumber: quote.number, title: `Send me the PDF of quote Q-${quote.number}` };
  if (card.kind === "watch") return { ...card, watch: { ...card.watch, quoteId: `Q-${quote.number}` } };
  return card;
}

/**
 * A quote_pdf of a quote this plan BUILT is already done: building it queued its
 * PDF to the person's linked WhatsApp in the same transaction as the quote. A
 * second copy would only be noise.
 */
export function pdfAlreadySent(plan: PlanState, step: PlanStep): boolean {
  return step.card.kind === "quote_pdf" && Boolean(step.fromStep) && plan.steps[step.fromStep! - 1]?.card.kind === "quote_build";
}

/** How a step's outcome is recorded. `unchanged`/`resumable`: provably nothing (more) to undo — Retry runs it again. */
export function stepStatusFor(outcome: { ok: boolean; unchanged?: boolean; resumable?: boolean }): PlanStepStatus {
  if (outcome.ok) return "done";
  return outcome.unchanged || outcome.resumable ? "refused" : "failed";
}

/** The plan as the person reads it. `taskStatus` is the AssistantTask row's own. */
export function planView(task: { id: string; title: string; status: string; quoteId: string | null }, plan: PlanState, now = new Date()): PlanView {
  const steps = plan.steps.map(({ n, title, status, message, href }) => ({ n, title, status, ...(message ? { message } : {}), ...(href ? { href } : {}) }));
  const next = nextStep(plan);
  const stopped = plan.steps.find((s) => s.status === "failed" || s.status === "refused");
  const running = plan.steps.some((s) => s.status === "running");
  const ran = plan.steps.filter((s) => s.status === "done").length;
  const expired = new Date(plan.expiresAt).getTime() <= now.getTime();
  let status: PlanStatus;
  let summary: string;
  if (!next) {
    status = "done";
    summary = `Done — all ${plan.steps.length} steps ran.`;
  } else if (task.status === "closed") {
    status = "closed";
    summary = `Closed — ${ran} of ${plan.steps.length} steps ran; the rest won't.`;
  } else if (running) {
    status = "running";
    summary = `Running step ${next.n}…`;
  } else if (expired) {
    status = "expired";
    summary = `Expired — ${ran} of ${plan.steps.length} steps ran; the rest won't. Ask again if you still want them.`;
  } else if (stopped) {
    status = "paused";
    summary = `Paused at step ${stopped.n} — ${stopped.message ?? "it didn't work."}${stopped.status === "failed" && !RETRY_SAFE_KINDS.has(stopped.card.kind) ? " It can't be retried from here, because I can't be sure nothing was changed — check it, then Close this plan and ask again." : ""}`;
  } else {
    status = "waiting";
    summary = ran ? `Paused before step ${next.n}.` : "Waiting for your Confirm — nothing has run yet.";
  }
  const retryBlocked = stopped?.status === "failed" && !RETRY_SAFE_KINDS.has(stopped.card.kind);
  return {
    taskId: task.id, title: task.title, status, summary, steps, sends: plan.sends, quoteId: task.quoteId,
    canRun: (status === "waiting" || status === "paused") && !retryBlocked,
  };
}

/** The person's step lists on the task row, kept in line with the plan (the job sheet's own `steps`). */
export const planStepLists = (plan: PlanState) => ({
  done: plan.steps.filter((s) => s.status === "done").map((s) => `${s.n}. ${s.title}`).slice(-12),
  outstanding: plan.steps.filter((s) => s.status !== "done").map((s) => `${s.n}. ${s.title}`),
});

export const PLAN_INSTRUCTIONS = [
  'MULTI-STEP PLANS. When ONE request asks for several things done in a row ("quote Werner, send me the PDF, draft the email and remind me Friday"), propose them as ONE plan instead of separate tasks — put a "plan" key in the reply block:',
  '"plan":{"title":"<short — Quote Werner Kilian: Rover XL, PDF, email, reminder Friday>","steps":[{"type":"quote_build","contactId":"<id>","lines":[{"productId":"<id>","qty":1}]},{"type":"quote_pdf","dependsOn":1},{"type":"draft_message","leadId":"<id>","channel":"email","subject":"...","body":"..."},{"type":"follow_up","leadId":"<id>","when":"YYYY-MM-DDTHH:MM","activity":"call","summary":"..."}]}',
  `- Each step is written exactly like a task in "actions" — the same types, fields and rules. 2 to ${PLAN_MAX_STEPS} steps, in the order they should run.`,
  '- "dependsOn": the number (1 = the first step) of an earlier step whose result this one uses. A quote_pdf of the quote the plan builds leaves "quote" out and gives "dependsOn" with the quote_build\'s number.',
  "- One Confirm runs the steps in order. It stops at the first step that fails or is refused and shows what ran; Retry carries on from there and never makes a second quote.",
  "- A message to the customer (draft_message) is NEVER run by the plan: put it in its place among the steps and it becomes its own card with a Send button that they press themselves.",
  '- Use a plan only for 2 or more things the person asked for together; a single task goes in "actions". Never put the same task in both.',
  "- Say you've set up a plan for them to confirm — never that any of it is done.",
].join("\n");
