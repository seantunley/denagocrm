import { assistantStep, type ToolStep } from "./crmAssistantPlan";

/**
 * Questions so common and so plain that the research step would always pick
 * the same lookup — "what needs my attention?", "what's overdue for me?",
 * "what should I do with this one?" on a lead's page. For those the research
 * round (a whole ChatGPT call, about 4 s) is skipped and the lookup runs at
 * once. The answer is still written by DAX, in its own voice.
 *
 * DELIBERATELY NARROW: whole-question patterns only, nothing that names a
 * customer or a period, nothing with a second clause ("…and draft a message").
 * Anything not matched goes the normal way, so a miss costs nothing but the
 * 4 s it would have cost anyway — a wrong match would cost a wrong answer.
 *
 * Also what DAX can still do when ChatGPT is down (assistantBreaker): these
 * lookups need no model to choose them.
 */

const tidy = (q: string) =>
  q
    .trim()
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/^(hey |hi |ok |okay )?(dax[, ]+)?(please |can you |could you )?/, "")
    .replace(/[?!.\s]+$/g, "")
    .replace(/\s+/g, " ");

const ATTENTION = /^(what (needs|need|requires) (my )?attention( today)?|what should i (do|focus on|work on)( first)?( today)?|plan my day|(what'?s|what is) on my plate( today)?|my day|(give me )?(my|the) (daily )?brief(ing)?|daily brief(ing)?)$/;
const OVERDUE = /^(what'?s|what is|show( me)?|list) (overdue|late)( for me)?$|^(what'?s|show( me)?|list) my overdue( tasks| follow-?ups| activities)?$/;
const MINE = /\b(for me|my)\b/;
const TODAY = /^(what'?s|what is|show( me)?) (on )?(my )?(calendar|agenda|schedule|diary) (for )?today$|^what do i have (on )?today$/;
const PIPELINE = /^(how many open leads( do i have| are there)?|(show( me)? )?(my |the )?pipeline( summary)?|how'?s the pipeline( looking)?)$/;
const AWAITING = /^((which|what) )?quotes? (are )?(still )?(waiting|awaiting) (for )?(a )?signatures?$/;
// A manager's check-in. Both lookups go through the asker's own visibility, so a
// rep asking this just gets their own numbers.
const TEAM = /^(how( is|'s| are) (my|the) (team|sales ?people|salespeople|reps)( doing| performing)?( this (week|month))?|(who|which of my (team|people|reps)) (needs|need) (help|coaching|a push)|where does my team need help|(team|coaching) (check-?in|review|update)|coach my team)$/;
const THIS_ONE = /^(what should i do( here| next)?( with (this|him|her|them|this one|this lead|this customer|this deal))?|where are we( with (this|him|her|them|this one|this deal))?|summari[sz]e (this|him|her|them|this lead|this customer|this deal)|(what'?s|what is) (happening|going on)( here| with (this|him|her|them|this one|this deal))|tell me about (this|him|her|them)( one| lead| customer| deal)?)$/;

export type FastPathContext = {
  userName: string;
  /** The lead or customer id the page is about (pageContext), if any. */
  pageLead: string | null;
};

/** The lookups for a question that needs no research step, or null to go the normal way. */
export function fastPath(question: string, ctx: FastPathContext): ToolStep[] | null {
  const q = tidy(question);
  if (!q || q.length > 80) return null;
  const steps: unknown[] = [];
  if (ATTENTION.test(q)) steps.push({ tool: "daily_brief", args: {} });
  else if (TEAM.test(q)) steps.push({ tool: "daily_brief", args: {} }, { tool: "sales_stats", args: {} });
  else if (OVERDUE.test(q)) steps.push({ tool: "find_activities", args: { when: "overdue", ...(MINE.test(q) ? { assignedTo: ctx.userName } : {}) } });
  else if (TODAY.test(q)) steps.push({ tool: "find_activities", args: { when: "today", ...(MINE.test(q) || /^what do i/.test(q) ? { assignedTo: ctx.userName } : {}) } });
  else if (PIPELINE.test(q)) steps.push({ tool: "pipeline_summary", args: {} });
  else if (AWAITING.test(q)) steps.push({ tool: "find_quotes", args: { awaitingSignature: true } });
  else if (ctx.pageLead && THIS_ONE.test(q)) steps.push({ tool: "lead_brief", args: { lead: ctx.pageLead } });
  if (!steps.length) return null;
  // Through the same schema the research step's choices go through.
  const parsed = steps.map((s) => assistantStep.safeParse(s));
  if (!parsed.every((p) => p.success)) return null;
  return parsed.map((p) => p.data as ToolStep);
}

/** The lead/customer id a page hint names ("use lead_brief with "<id>""), for "this one". */
export function pageLeadFromHint(hint: string): string | null {
  return /use lead_brief with (?:that id|"([^"]+)")/.exec(hint)?.[1] ?? /(?:lead|customer) id (c[a-z0-9]{20,})/i.exec(hint)?.[1] ?? null;
}
