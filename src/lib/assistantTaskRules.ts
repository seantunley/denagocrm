import { z } from "zod";
import { scanEntry } from "./assistantMemory";
import { stripInvisible } from "./invisibleText";
import { QUOTE_ADD_MAX_FEES, QUOTE_ADD_MAX_FEE_RANDS, QUOTE_BUILD_MAX_LINES } from "./assistantActions";

/**
 * DAX's JOB SHEETS (roadmap Phase 1, 2026-10-26) — the pure half: what the
 * answer step may write about a piece of work, how that is cleaned and merged
 * onto the sheet, and how open sheets read in the next prompt. No server-only
 * imports, so it is unit-tested directly; the database half is assistantTask.ts.
 *
 * A sheet holds the job as RECORDS, not loose sentences: the customer and deal
 * by id, the lines and fees the quote will carry, what is settled, what is
 * missing, and the next step. "Actually white" changes one line of it; "continue
 * that quote" tomorrow, on WhatsApp or in the CRM, reads the same sheet.
 *
 * IDS COME FROM THE CRM, NEVER THE MODEL. The model may NAME a contactId or
 * leadId, but it is kept only when this turn's own lookups returned that record
 * (keepIds), and a quoteId is never taken from the model at all — only from a
 * confirmed quote_build's result (assistantTask.recordTaskProgress).
 */

export const TASK_KINDS = ["quote"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export type TaskStatus = "open" | "done" | "closed";
/** A sheet with no activity for this long closes itself (Sean, 2026-10-26). It can still be found and reopened. */
export const TASK_STALE_DAYS = 14;
/** Open sheets put in front of each question — the newest activity first. */
export const TASK_PROMPT_MAX = 3;

export type TaskLine = { product: string; productId?: string; qty: number; colour?: string; discountPct?: number };
export type TaskFee = { label: string; amount: number; delivery?: boolean };
export type TaskDetails = { lines?: TaskLine[]; fees?: TaskFee[]; confirmed?: string[]; missing?: string[] };
export type TaskSteps = { done: string[]; outstanding: string[] };

/** What the answer step wrote, cleaned. Every field optional: what is left out stays as it was. */
export type TaskUpdate = {
  id?: string;
  kind: TaskKind;
  title?: string;
  status?: TaskStatus;
  contactId?: string;
  leadId?: string;
  lines?: TaskLine[];
  fees?: TaskFee[];
  confirmed?: string[];
  missing?: string[];
  done?: string[];
  outstanding?: string[];
  next?: string;
};

/** A sheet as one question sees it: ids re-checked against the person's access, the quote read from the CRM. */
export type TaskView = {
  id: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  contactId: string | null;
  leadId: string | null;
  quoteId: string | null;
  /** The quote as the CRM holds it now — never as the sheet remembers it. Null when there is none, or the person can no longer open it. */
  quote: { number: number; status: string; lines: string[]; fees: string[] } | null;
  details: TaskDetails;
  steps: TaskSteps;
  nextAction: string | null;
  version: number;
  updatedAt: Date;
};

// Loose bounds only to refuse garbage; the caps below clip rather than reject.
const loose = z.string().max(2000);
const looseList = z.array(loose).max(50);
const id = z.string().trim().regex(/^[\w-]{10,64}$/);
const taskSchema = z.object({
  id: id.optional(),
  kind: z.enum(TASK_KINDS),
  title: loose.optional(),
  status: z.enum(["open", "done", "closed"]).optional(),
  contactId: id.optional(),
  leadId: id.optional(),
  lines: z.array(z.object({
    product: z.string().max(200).optional(),
    productId: id.optional(),
    qty: z.number().int().min(1).max(500),
    colour: z.string().max(100).optional(),
    discountPct: z.number().min(0).max(100).optional(),
  }).passthrough()).max(50).optional(),
  fees: z.array(z.object({
    label: z.string().max(200),
    amount: z.number().positive().max(QUOTE_ADD_MAX_FEE_RANDS),
    delivery: z.boolean().optional(),
  }).passthrough()).max(50).optional(),
  confirmed: looseList.optional(),
  missing: looseList.optional(),
  done: looseList.optional(),
  outstanding: looseList.optional(),
  next: loose.optional(),
}).passthrough();

/** Free text read back into the next prompt: the memory scan (no instructions, no contact details), one line, capped. */
const prose = (v: string | undefined, max: number) => {
  const scanned = v ? scanEntry(v) : null;
  return scanned?.ok ? scanned.text.replace(/\s+/g, " ").slice(0, max).trim() : undefined;
};
const proseList = (vs: string[] | undefined, max: number, cap: number) =>
  vs === undefined ? undefined : [...new Set(vs.map((v) => prose(v, max)).filter((v): v is string => Boolean(v)))].slice(0, cap);
/** A short name (a product, a colour, a fee): re-resolved against the catalogue or shown on a card before anything is saved. */
const name = (v: string | undefined, max: number) => {
  const t = v ? stripInvisible(v).replace(/\s+/g, " ").trim().slice(0, max) : "";
  return t || undefined;
};

/**
 * The reply block's "task" → a cleaned update, or null (not a sheet at all).
 * A malformed line or fee is dropped on its own; one bad list does not cost the rest.
 */
export function parseTaskUpdate(raw: unknown): TaskUpdate | null {
  const parsed = taskSchema.safeParse(raw);
  if (!parsed.success) return null;
  const t = parsed.data;
  const lines = t.lines?.flatMap((l): TaskLine[] => {
    const product = name(l.product, 120);
    if (!product && !l.productId) return [];
    return [{
      product: product ?? "", ...(l.productId ? { productId: l.productId } : {}), qty: l.qty,
      ...(name(l.colour, 60) ? { colour: name(l.colour, 60) } : {}), ...(l.discountPct ? { discountPct: l.discountPct } : {}),
    }];
  }).slice(0, QUOTE_BUILD_MAX_LINES);
  const fees = t.fees?.flatMap((f): TaskFee[] => {
    const label = name(f.label, 120);
    return label ? [{ label, amount: f.amount, ...(f.delivery ? { delivery: true } : {}) }] : [];
  }).slice(0, QUOTE_ADD_MAX_FEES);
  const update: TaskUpdate = {
    kind: t.kind,
    ...(t.id ? { id: t.id } : {}),
    ...(prose(t.title, 120) ? { title: prose(t.title, 120) } : {}),
    ...(t.status ? { status: t.status } : {}),
    ...(t.contactId ? { contactId: t.contactId } : {}),
    ...(t.leadId ? { leadId: t.leadId } : {}),
    ...(lines ? { lines } : {}),
    ...(fees ? { fees } : {}),
    ...(t.confirmed ? { confirmed: proseList(t.confirmed, 200, 8) } : {}),
    ...(t.missing ? { missing: proseList(t.missing, 200, 8) } : {}),
    ...(t.done ? { done: proseList(t.done, 200, 8) } : {}),
    ...(t.outstanding ? { outstanding: proseList(t.outstanding, 200, 8) } : {}),
    ...(prose(t.next, 200) ? { next: prose(t.next, 200) } : {}),
  };
  return update;
}

/**
 * The ids the model named, kept only where this turn's lookups returned that
 * record (`seen`: turnRefs — "contact:<id>", "lead:<id>"). An id it did not see
 * this turn is dropped, so the sheet keeps whatever it held before.
 */
export function keepIds(update: TaskUpdate, seen: ReadonlySet<string>): TaskUpdate {
  const { contactId, leadId, ...rest } = update;
  return {
    ...rest,
    ...(contactId && seen.has(`contact:${contactId}`) ? { contactId } : {}),
    ...(leadId && seen.has(`lead:${leadId}`) ? { leadId } : {}),
  };
}

type Stored = { title: string; status: string; contactId: string | null; leadId: string | null; quoteId: string | null; details: TaskDetails; steps: TaskSteps; nextAction: string | null };

/**
 * The sheet after an update. What the update leaves out stays. Lists it gives
 * replace the old ones (the model writes the whole sheet as it stands), except
 * `done`, which only grows: a step the CRM recorded (a quote created) is never
 * written away by the model. ONCE THERE IS A QUOTE, the quote is the truth: its
 * customer, deal, lines and fees are not the model's to rewrite — a correction
 * is a quote_change card instead.
 */
export function mergeTask(current: Stored | null, update: TaskUpdate): Stored {
  const base: Stored = current ?? { title: "", status: "open", contactId: null, leadId: null, quoteId: null, details: {}, steps: { done: [], outstanding: [] }, nextAction: null };
  const locked = Boolean(base.quoteId);
  const details: TaskDetails = {
    ...base.details,
    ...(!locked && update.lines ? { lines: update.lines } : {}),
    ...(!locked && update.fees ? { fees: update.fees } : {}),
    ...(update.confirmed ? { confirmed: update.confirmed } : {}),
    ...(update.missing ? { missing: update.missing } : {}),
  };
  return {
    title: update.title ?? base.title,
    status: update.status ?? base.status,
    contactId: locked ? base.contactId : update.contactId ?? base.contactId,
    leadId: locked ? base.leadId : update.leadId ?? base.leadId,
    quoteId: base.quoteId,
    details,
    steps: {
      done: [...new Set([...base.steps.done, ...(update.done ?? [])])].slice(-12),
      outstanding: update.outstanding ?? base.steps.outstanding,
    },
    nextAction: update.next ?? base.nextAction,
  };
}

/** Stored JSON → details / steps, tolerating anything malformed (it reads as empty, never throws). */
export function readDetails(raw: unknown): TaskDetails {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as TaskDetails) : {};
}
export function readSteps(raw: unknown): TaskSteps {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Partial<TaskSteps>) : {};
  return { done: Array.isArray(o.done) ? o.done.map(String) : [], outstanding: Array.isArray(o.outstanding) ? o.outstanding.map(String) : [] };
}

const lineText = (l: TaskLine) => `${l.qty} × ${l.product || l.productId}${l.colour ? ` (${l.colour})` : ""}${l.discountPct ? `, less ${l.discountPct}%` : ""}`;
const feeText = (f: TaskFee) => `${f.delivery ? "Delivery" : "Fee"}: ${f.label} — R${f.amount.toLocaleString("en-ZA")}`;

/** "2026-10-26" — the day a sheet was last touched, South African time. */
const day = (d: Date) => new Date(d.getTime() + 2 * 3600_000).toISOString().slice(0, 10);

/** Open sheets as the model reads them, fenced as data by the caller. */
export function taskBlock(tasks: readonly TaskView[]): string {
  if (!tasks.length) return "";
  return tasks.map((t) => {
    const d = t.details;
    return [
      `Job sheet id ${t.id} — ${t.title} (${t.kind}, open, last touched ${day(t.updatedAt)})`,
      t.contactId ? `Customer: contactId ${t.contactId}` : "",
      t.leadId ? `Deal: leadId ${t.leadId}` : "",
      t.quote
        ? `Quote: Q-${t.quote.number} (${t.quote.status}) — on it now: ${[...t.quote.lines, ...t.quote.fees].join("; ") || "nothing yet"}`
        : t.quoteId ? "Quote: made, but you cannot open it now" : "",
      !t.quoteId && d.lines?.length ? `Lines: ${d.lines.map(lineText).join("; ")}` : "",
      !t.quoteId && d.fees?.length ? `Fees: ${d.fees.map(feeText).join("; ")}` : "",
      d.confirmed?.length ? `Settled: ${d.confirmed.join("; ")}` : "",
      d.missing?.length ? `Still missing: ${d.missing.join("; ")}` : "",
      t.steps.done.length ? `Done: ${t.steps.done.join("; ")}` : "",
      t.steps.outstanding.length ? `Outstanding: ${t.steps.outstanding.join("; ")}` : "",
      t.nextAction ? `Next: ${t.nextAction}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

export const TASK_INSTRUCTIONS = [
  'JOB SHEETS. When the person is putting a QUOTE together with you, keep a job sheet for it: put a "task" key in the reply block with the WHOLE sheet as it stands now (not just this answer\'s change):',
  '"task":{"id":"<the id of the open job sheet you are continuing, exactly as listed under Open job sheets — leave it out to start a new one>","kind":"quote","title":"<short — Quote for Anna Jacobs: Rover XL>","contactId":"<the customer\'s contactId from the CRM results>","leadId":"<the deal\'s leadId from the CRM results, only if it is for a deal>","lines":[{"product":"<as the catalogue names it>","productId":"<from the results>","qty":1,"colour":"<as the catalogue spells it>","discountPct":0}],"fees":[{"label":"Delivery — Hermanus","amount":6500,"delivery":true}],"confirmed":["<what the person has settled>"],"missing":["<what you still need from them>"],"done":["<steps done>"],"outstanding":["<steps still to do>"],"next":"<the one next step>","status":"open|done|closed"}',
  "- A correction (\"actually white\", \"make it two\") changes that one thing on the sheet; everything else stays.",
  "- \"Continue that quote\", \"where were we with Anna\": continue the open job sheet it means, by its id. If more than one open sheet could be meant, ASK which (offer them as choices) — never guess.",
  "- The CRM fills a quote_build's customer, deal, lines and fees FROM THE SHEET — keep the sheet right; what the sheet says wins over anything typed on the quote_build.",
  "- Once a sheet shows a Quote (Q-…), that quote is the truth: a correction is a quote_change, an addition a quote_add — leave \"quote\" out of them and the CRM uses the sheet's quote. Don't rewrite its lines on the sheet, and never propose a second quote_build for it.",
  "- contactId and leadId only as they appear in the CRM results or on the sheet — never invent one. status \"done\" when the job is finished, \"closed\" when they say to drop it.",
  "- One job sheet per answer, and none for a plain question. Never phone numbers, email addresses or a customer's words verbatim on it.",
  "- Don't describe the sheet in your answer — the CRM adds a line naming it.",
].join("\n");
