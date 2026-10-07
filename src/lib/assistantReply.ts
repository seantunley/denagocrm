import { learnBlock, splitLearn, type LearnBlock } from "./assistantMemory";
import { parseActionList, parseChoiceList, splitActions, splitChoices, type ProposedAction } from "./assistantActions";

/**
 * DAX's reply, as one contract: the answer the person reads, then (only when
 * there is something) ONE marker line and ONE JSON object carrying everything
 * that isn't for reading — what to learn, tasks to confirm, quick replies.
 *
 * It replaces three separate trailer lines (LEARN:, ACTIONS:, CHOICES:), each
 * found and parsed on its own. One stray line out of place used to leak
 * control text into the answer, or lose a task. Now there is one boundary to
 * find, and everything after it is hidden while streaming and never shown.
 * Each part of the block is validated on its own: a malformed task list
 * doesn't cost the quick replies or the learning.
 *
 * Replies in the old shape are still read (the legacy splitters), so an
 * answer written mid-rollout, or a model that slips back, loses nothing.
 *
 * The marker can't be forged from inside the data: resultsBlock turns every
 * `<` before a letter in customer text into ‹, so "<<DAX>>" can't survive the
 * fence for the model to echo back.
 */
export const REPLY_MARKER = "<<DAX>>";

export const REPLY_FORMAT = [
  "REPLY FORMAT. Write your answer for the person. If — and only if — you have something to learn, tasks to propose or choices to offer, end with a line containing exactly",
  REPLY_MARKER,
  'and then ONE JSON object on the next line with just the keys you need: {"learn":{...},"actions":[...],"choices":[...]}. Nothing after it. Never mention the marker or the block in your answer.',
].join("\n");

export type ParsedReply = { answer: string; learn: LearnBlock | null; actions: ProposedAction[]; choices: string[] };

/** The reply → the answer and its validated block (or the legacy trailer lines). */
export function splitReply(reply: string): ParsedReply {
  const lines = reply.trimEnd().split("\n");
  const at = lines.findLastIndex((line) => line.trim() === REPLY_MARKER);
  if (at === -1) return legacy(reply);
  const block = blockObject(lines.slice(at + 1).join("\n"));
  // Anything old-style that slipped into the answer part is still taken out.
  const before = legacy(lines.slice(0, at).join("\n"));
  const learn = block && "learn" in block ? learnBlock.safeParse(block.learn) : null;
  const actions = block ? parseActionList(block.actions) : [];
  const choices = block ? parseChoiceList(block.choices) : [];
  return {
    answer: before.answer,
    learn: learn?.success ? learn.data : before.learn,
    actions: actions.length ? actions : before.actions,
    choices: choices.length ? choices : before.choices,
  };
}

function legacy(reply: string): ParsedReply {
  const learnSplit = splitLearn(reply);
  const choiceSplit = splitChoices(learnSplit.answer);
  const { answer, actions } = splitActions(choiceSplit.answer);
  return { answer, learn: learnSplit.learn, actions, choices: choiceSplit.choices };
}

/** The block's JSON object (a code fence around it tolerated), or null. */
function blockObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const raw: unknown = JSON.parse(text.slice(start, end + 1));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* ── Evidence ─────────────────────────────────────────────────────────────── */

/**
 * "Why do you say that?" — a fact can carry the link of the record it came
 * from, written [[/leads/…]] after it, and the person sees a chip that opens
 * that record. Only links that came back in this answer's own lookups survive:
 * those were read through the person's own access, so a chip can never point
 * at something they can't open, and a made-up link just disappears.
 */
export type Evidence = { label: string; href: string };
export const CITE = /\[\[\s*(\/[^\]\s]{1,200})\s*\]\]/g;

export const CITE_RULE =
  'EVIDENCE. Records in the results carry a "link". After a fact you took from a record, you may put its link in double brackets — "Anna opened the quote yesterday [[/quotes/abc123]]" — and the person gets a button that opens it. Only links that appear in the results, copied exactly; at most one per sentence, on the facts that matter most, not every line.';

/**
 * The answer with its citations numbered ([[1]], [[2]] — the chips), the same
 * answer with them taken out (for history, WhatsApp, anywhere without chips),
 * and the records they point at. Unknown links are dropped.
 */
export function resolveCitations(answer: string, citable: Map<string, string>): { cited: string; plain: string; evidence: Evidence[] } {
  const evidence: Evidence[] = [];
  const index = new Map<string, number>();
  const cited = answer.replace(CITE, (_all, href: string) => {
    const label = citable.get(href);
    if (!label) return "";
    let n = index.get(href);
    if (n === undefined) {
      evidence.push({ label, href });
      n = evidence.length;
      index.set(href, n);
    }
    return `[[${n}]]`;
  });
  return { cited: tidy(cited), plain: tidy(cited.replace(/\[\[\d+\]\]/g, "")), evidence };
}

/** No space left before punctuation, or doubled, where a citation came out. */
const tidy = (s: string) => s.replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();

/**
 * Every record link in a lookup's results, with a short name for its chip —
 * the quote number, the customer, the activity. Walks the data as returned,
 * so a link nested in a lead's brief (its quotes) is citable too.
 */
export function citableLinks(data: unknown, into: Map<string, string> = new Map()): Map<string, string> {
  if (Array.isArray(data)) {
    for (const item of data) citableLinks(item, into);
  } else if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (typeof o.link === "string" && o.link.startsWith("/") && !into.has(o.link)) {
      const name = [o.quote, o.customer, o.summary, o.title, o.vehicle, o.unit, o.lead].find((v) => typeof v === "string" && v.trim());
      into.set(o.link, String(name ?? "Open").slice(0, 40));
    }
    for (const value of Object.values(o)) if (value && typeof value === "object") citableLinks(value, into);
  }
  return into;
}
