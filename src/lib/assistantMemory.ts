import { z } from "zod";
import { stripInvisible } from "./invisibleText";
import { johannesburgDateKey } from "./activityDay";

/**
 * How the assistant learns — the pure half (parsing, limits, safety scan).
 *
 * Ported from Hermes Agent's memory tool and skills (Nous Research, MIT):
 *  - MEMORY.md → workspace MEMORY: facts about this business that matter in every
 *    conversation (who handles what, conventions, policies someone stated).
 *  - USER.md → a personal PROFILE per user: how they like answers, their role/area.
 *  - skills → PLAYBOOKS: a named definition or procedure ("hot lead" = …), with a
 *    ≤60-character description that sits in every prompt and a body that loads
 *    only when needed.
 * Same discipline as Hermes: small hard caps (memory is in every prompt), only
 * durable facts, and every entry scanned for injected instructions because it
 * becomes part of the system prompt. Sean chose "learns on its own, the owner
 * reviews": entries apply straight away, marked unreviewed until approved.
 */

export const MEMORY_CHAR_LIMIT = 2200; // Hermes' MEMORY.md default
// Hermes' USER.md default is 1400; more room here because a person can now
// write their own "about me" as well as what it learns from them.
export const PROFILE_CHAR_LIMIT = 2000;
export const PLAYBOOK_LIMIT = 30;
export const PLAYBOOK_CHARS = 1500;
export const ENTRY_CHARS = 400;

const entryText = z.string().trim().min(3).max(ENTRY_CHARS);
// The last day a time-bound rule applies ("for October…"). A bad date only
// loses the expiry, never the lesson: it is dropped, not the whole block.
const until = z
  .string()
  .refine((day) => parseUntil(day) !== null)
  .optional()
  .catch(undefined);
const noteOp = z.union([
  z.object({ add: entryText, until }).strict(),
  z.object({ replace: z.object({ old: z.string().trim().min(3).max(ENTRY_CHARS), new: entryText }).strict(), until }).strict(),
  z.object({ remove: z.string().trim().min(3).max(ENTRY_CHARS) }).strict(),
]);
export const playbookOp = z
  .object({
    name: z.string().trim().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(48),
    description: z.string().trim().min(3).max(60),
    content: z.string().trim().min(10).max(PLAYBOOK_CHARS),
  })
  .strict();

export const decisionOp = z
  .object({
    kind: z.enum(["lead", "topic"]),
    subject: z.string().trim().min(1).max(80),
    text: z.string().trim().min(3).max(400),
  })
  .strict();
export const learnBlock = z
  .object({
    memory: z.array(noteOp).max(5).optional(),
    profile: z.array(noteOp).max(5).optional(),
    playbook: z.array(playbookOp).max(3).optional(),
    /** Case decisions — stored separately, retrieved via recall_decision. */
    decision: z.array(decisionOp).max(3).optional(),
  })
  .strict();
export type LearnBlock = z.infer<typeof learnBlock>;
export type NoteOp = z.infer<typeof noteOp>;

export const LEARN_INSTRUCTIONS = [
  'LEARNING. You remember across conversations. ONLY if this exchange taught you something durable, put it under "learn" in the reply block:',
  '"learn":{"memory":[{"add":"..."}],"profile":[{"add":"..."}],"playbook":[{"name":"hot-lead","description":"<=60 chars","content":"..."}]}',
  'Each list is optional. Ops: {"add":"text"}, {"replace":{"old":"words in the existing entry","new":"whole new entry"}}, {"remove":"words in the entry"}.',
  'A rule that only holds for a while ("for October…", "until the promo ends on the 15th") gets "until":"YYYY-MM-DD" (its last day) on the add or replace op.',
  "- memory: facts about THIS BUSINESS that matter in every future conversation — who handles what, how things are done here, policies someone told you.",
  "- profile: this person's own lasting preferences — how they like answers, their role, their area.",
  "- playbook: a named definition or procedure the person taught or corrected (\"hot lead means…\", \"our weekly review is…\"). name is lowercase-hyphenated.",
  "A correction from the person is the most important thing to learn. If an entry you were given is wrong or out of date, replace or remove it.",
  "SKIP for memory/profile/playbook: anything about one particular customer or deal, data that lives in the CRM records, one-off tasks, guesses. Never store a phone number, email address or a customer's name.",
  '- decision: a decision made about a customer or topic this turn. kind is required: "lead" (subject is a lead id) or "topic". Example: {"decision":[{"kind":"lead","subject":"<lead id>","text":"Wait until finance replies"}]}. These are stored separately and retrieved with recall_decision — they do not go into the prompt.',
  'Most answers learn nothing — then leave "learn" out.',
].join("\n");

/**
 * Learning from its own work (Hermes writes a skill after a task that took
 * several tool calls, and patches it when it falls short). Only offered when
 * this answer took MIN_METHOD_LOOKUPS or more: the method that worked, as a
 * playbook the plan step can load next time — still unreviewed until the owner
 * approves it, and never about one particular customer.
 */
export const MIN_METHOD_LOOKUPS = 2;

export function methodInstructions(lookups: { tool: string; args: unknown }[]): string {
  if (lookups.length < MIN_METHOD_LOOKUPS) return "";
  // The lookups themselves (tool + filters, which a model chose after reading
  // customer text) are NOT copied into these instructions: they're already in
  // the fenced results, each with its filters, cleaned. Only tool names here.
  return [
    `METHOD. Answering this took ${lookups.length} lookups (${lookups.map((l) => l.tool).join(" → ")}); their filters are with each result above.`,
    "If this is a KIND of question that will come up again (\"who should I chase\", \"is X ready for delivery\" — not one about a particular customer) and no playbook already covers it, save the method as a playbook under \"learn\": a name for that kind of question, a one-line description, and the steps — which lookups with which filters, what to look for in the results, and how to judge them. Leave out names and anything specific to today's records.",
    "If you loaded a playbook and it was missing a step you needed, improve it (replace). If the method was obvious or one-off, learn nothing.",
  ].join("\n");
}

/** Split the model's reply into the answer the person sees and what it wants to learn. */
export function splitLearn(reply: string): { answer: string; learn: LearnBlock | null } {
  const lines = reply.trimEnd().split("\n");
  const at = lines.findLastIndex((line) => line.trim().startsWith("LEARN:"));
  if (at === -1) return { answer: reply.trim(), learn: null };
  const answer = lines.filter((_, i) => i !== at).join("\n").trim();
  const json = lines[at].trim().slice("LEARN:".length).trim();
  try {
    const parsed = learnBlock.safeParse(JSON.parse(json));
    return { answer, learn: parsed.success ? parsed.data : null };
  } catch {
    return { answer, learn: null };
  }
}

/* ── Safety scan ─────────────────────────────────────────────────────────── */

const INJECTION = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|messages)/i,
  /disregard (all |any |the )?(previous|prior|above|your) /i,
  /\b(system|developer) prompt\b/i,
  /\byou are now\b/i,
  /\bnew instructions?\b/i,
  /\b(reveal|print|show|send|leak)\b.{0,40}\b(prompt|instructions|api ?key|token|password|secret)/i,
  /\b(api ?key|password|secret|token)\s*[:=]/i,
  /<\s*\/?\s*(script|system|instructions?)\b/i,
  /\bLEARN:/,
  // The reply block's marker (assistantReply.REPLY_MARKER): a remembered entry
  // that carried it would sit in every prompt, ready to be echoed as a block.
  /<<\s*DAX\s*>>/i,
];
// Letters of ANY script (a Cyrillic look-alike domain is still a domain),
// spaces around the @, and the ideographic/halfwidth full stops as dots.
const EMAIL = /[\p{L}\p{N}._%+-]+\s*@\s*[\p{L}\p{N}-]+(?:\s*[.。．｡]\s*[\p{L}\p{N}-]+)+/iu;
// Any run of 9+ digits — of any script (Arabic-Indic, Devanagari…) — whatever
// separates them: up to three characters that are neither letters nor digits
// (":", "|", "~", "−", "*"… not a whitelist that misses the next one). The one
// exception is a comma followed by a space — a list ("120, 45, 300") — while
// "082,123,4567" still counts. (Fullwidth forms are folded by NFKC first.)
const PHONE = /\p{Nd}(?:(?:[^\p{L}\p{Nd}\n,]{0,3}|,(?=\p{Nd}))\p{Nd}){8,}/u;
// Removed before the phone check — replaced with a WORD, so they can't glue the
// digits either side into one run, nor hide a phone that only looks like one:
// real dates only (19xx/20xx years, months ≤ 12, days ≤ 31), and money in
// thousands groups that isn't followed by more digits ("R1,250,000.00",
// "ZAR 450 000" — but "R 082 123 4567" is still a phone). Times are left in:
// one or two of them are never nine digits.
const DATE_OR_TIME =
  /\b(?:19|20)\d\d[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])\b|\b(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.](?:19|20)\d\d\b/g;
// Not followed by ANY separator-then-digit (so "$082-123-4567" isn't eaten
// down to its tail), and an "amount" of nine or more digits is a phone wearing
// a currency sign ("R0 821 234 567") — kept for the phone check, not removed.
const MONEY = /(?:\bR|\bZAR|\$|€|£)\s?(\d{1,3}(?:[ ,.']\d{3})*)(?:[.,]\d{2})?(?![^\p{L}\p{Nd}\n]{0,3}\p{Nd})/giu;
const withoutMoney = (text: string) => text.replace(MONEY, (whole, int: string) => (int.replace(/\D/g, "").length >= 9 ? whole : " amount "));

/** Cleaned text, or a reason it may not be learned. */
export function scanEntry(raw: string): { ok: true; text: string } | { ok: false; reason: string } {
  // Collapse runs of spaces but keep line breaks: a playbook is a list of steps.
  const text = stripInvisible(raw).replace(/\r\n/g, "\n").replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length < 3) return { ok: false, reason: "empty" };
  if (INJECTION.some((pattern) => pattern.test(text))) return { ok: false, reason: "looks like an instruction to the assistant" };
  if (EMAIL.test(text) || PHONE.test(withoutMoney(text).replace(DATE_OR_TIME, " when "))) {
    return { ok: false, reason: "contains contact details" };
  }
  return { ok: true, text };
}

/* ── Applying ops to a list of entries (pure, so limits are testable) ───── */

/**
 * status: "unreviewed" (learned, not yet looked at), "approved" (the owner's),
 * or "conflict" — learned, but it contradicts the approved entry
 * `conflictsWithId`, so it is held out of every prompt until the owner picks one.
 */
export type Entry = { id: string; content: string; status: string; conflictsWithId?: string | null; validUntil?: Date | null };
export type Change =
  | { kind: "create"; content: string; until?: string; conflictsWithId?: string }
  | { kind: "update"; id: string; content: string; until?: string; conflictsWithId?: string }
  | { kind: "delete"; id: string };

/**
 * Ops → changes against the current entries, refusing anything over `limit`
 * total characters. Approved entries are the owner's: the assistant may only
 * replace or remove its own unreviewed ones. New text that contradicts an
 * approved entry — or a "replace" aimed at one, which is the model correcting
 * it — is held as a conflict for the owner to settle, never used meanwhile.
 */
export function planNoteChanges(entries: Entry[], ops: NoteOp[], limit: number): Change[] {
  const working: Entry[] = entries.map((e) => ({ ...e }));
  const changes: Change[] = [];
  const total = () => working.reduce((n, e) => n + e.content.length, 0);
  const find = (words: string) => working.find((e) => e.content.toLowerCase().includes(words.toLowerCase()));
  const exists = (text: string) => working.some((e) => e.content.toLowerCase() === text.toLowerCase());
  const clashFor = (text: string) => working.find((e) => e.status === "approved" && conflictsWith(text, e.content));
  // One open question per approved entry: a held entry isn't in the prompt, so
  // the model may well learn the same thing again next time in other words.
  const pending = (approvedId: string, except?: Entry) =>
    working.some((e) => e !== except && e.status === "conflict" && e.conflictsWithId === approvedId);
  const extra = (until: string | undefined, clash: Entry | undefined) => ({
    ...(until ? { until } : {}),
    ...(clash ? { conflictsWithId: clash.id } : {}),
  });
  const create = (content: string, until: string | undefined, clash: Entry | undefined) => {
    working.push({ id: `new-${changes.length}`, content, status: clash ? "conflict" : "unreviewed", conflictsWithId: clash?.id });
    changes.push({ kind: "create", content, ...extra(until, clash) });
  };

  for (const op of ops) {
    if ("add" in op) {
      const scanned = scanEntry(op.add);
      if (!scanned.ok || exists(scanned.text) || total() + scanned.text.length > limit) continue;
      const clash = clashFor(scanned.text);
      if (clash && pending(clash.id)) continue;
      create(scanned.text, op.until, clash);
    } else if ("replace" in op) {
      const target = find(op.replace.old);
      const scanned = scanEntry(op.replace.new);
      // A held entry waits for the owner; the assistant can't change it meanwhile.
      if (!target || !scanned.ok || target.status === "conflict") continue;
      if (target.status === "approved") {
        // The owner's entry stays as it is; the correction waits beside it.
        if (exists(scanned.text) || pending(target.id) || total() + scanned.text.length > limit) continue;
        create(scanned.text, op.until, target);
        continue;
      }
      if (total() - target.content.length + scanned.text.length > limit) continue;
      const clash = clashFor(scanned.text);
      if (clash && pending(clash.id, target)) continue;
      Object.assign(target, { content: scanned.text, status: clash ? "conflict" : "unreviewed", conflictsWithId: clash?.id });
      changes.push(
        target.id.startsWith("new-")
          ? { kind: "create", content: scanned.text, ...extra(op.until, clash) }
          : { kind: "update", id: target.id, content: scanned.text, ...extra(op.until, clash) },
      );
    } else {
      const target = find(op.remove);
      if (!target || target.status === "approved" || target.status === "conflict" || target.id.startsWith("new-")) continue;
      working.splice(working.indexOf(target), 1);
      changes.push({ kind: "delete", id: target.id });
    }
  }
  return changes;
}

/* ── Time: when an entry stops applying ──────────────────────────────────── */

/** "YYYY-MM-DD" → that day (UTC midnight, the way a DATE column comes back), or null if it isn't a real day. */
export function parseUntil(text: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const day = new Date(`${text}T00:00:00Z`);
  // "2026-02-31" parses as 3 March; only a date that reads back the same is real.
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(text) ? day : null;
}

/** Today in South Africa, as the same kind of value — the business's day, not the UTC server's. */
export function saToday(now = new Date()): Date {
  return new Date(`${johannesburgDateKey(now)}T00:00:00Z`);
}

/** Past its last day. Still kept (the owner sees "Expired" and can extend it) — just never in a prompt. */
export const isExpired = (validUntil: Date | null | undefined, now = new Date()) => Boolean(validUntil && validUntil < saToday(now));

/**
 * What may go into a prompt: not held as a conflict, and not past its last
 * day (valid THROUGH validUntil). A Prisma filter, spread into each read.
 */
export function inUseWhere(now = new Date()) {
  return { status: { not: "conflict" }, AND: [{ OR: [{ validUntil: null }, { validUntil: { gte: saToday(now) } }] }] };
}

/* ── Conflicts: does new learning contradict an approved entry? ─────────── */

/*
 * Deterministic and cheap — it runs inside the learning write, with no extra
 * model call. Deliberately conservative: two shapes only, and anything it
 * can't read cleanly is NOT a conflict (the nightly tidy-up still flags what
 * this misses). A false alarm would hold good learning back from everyone.
 *
 *  1. Who owns what: "Sean handles fleet accounts" vs "Fleet deals go to
 *     Donovan" — both name one owner for the same topic, and the owners differ.
 *  2. The same statement, flipped or re-numbered: "We deliver on Saturdays" vs
 *     "We don't deliver on Saturdays"; "within 24 hours" vs "within 48 hours".
 *
 * ponytail: word sets, not grammar — misses paraphrases ("Donovan looks after
 * fleet" vs "fleet is Sean's"); the tidy-up is the backstop for those.
 */

const STOP = new Set(
  "a an the our we us you your i my me all any every each of to for in on at by with is are be was were will would should must can could may might it its this that these those than also only always just please do does did".split(" "),
);
const NEGATION = new Set(["not", "no", "never", "don't", "dont", "doesn't", "doesnt", "won't", "wont", "can't", "cant", "cannot", "isn't", "aren't", "shouldn't", "mustn't", "nobody", "none"]);
// Words that name the work, not which work: "fleet deals" and "fleet accounts" are one topic.
const GENERIC = new Set(["deal", "account", "customer", "client", "lead", "enquiry", "enquirie", "inquiry", "inquirie", "sale", "order", "quote", "job", "request"]);
const stem = (word: string) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);

function words(text: string) {
  const content = new Set<string>();
  const numbers = new Set<string>();
  let negative = false;
  for (const raw of text.toLowerCase().replace(/[‘’]/g, "'").split(/[^\p{L}\p{N}'%-]+/u)) {
    const word = raw.replace(/^['-]+|['-]+$/g, "");
    if (!word || STOP.has(word)) continue;
    if (NEGATION.has(word)) negative = true;
    else if (/\p{N}/u.test(word)) numbers.add(word);
    else content.add(stem(word));
  }
  return { content, numbers, negative };
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

const OWN_VERBS = "handles?|owns?|runs?|manages?|covers?|looks after|takes care of|is responsible for|is in charge of|deals with";
const NAME = String.raw`([A-Z][\p{L}'-]+(?: [A-Z][\p{L}'-]+)?)`;
const OWNER_FIRST = new RegExp(`^${NAME} (?:${OWN_VERBS}) (.+)$`, "u");
const OWNER_LAST = new RegExp(
  `^(.+?) (?:go(?:es)? to|belongs? to|(?:is|are) (?:handled|owned|run|managed|covered|looked after) by|(?:is|are) (?:assigned|routed|passed|sent) to) ${NAME}$`,
  "u",
);
const NOT_A_NAME = new Set(["we", "i", "they", "he", "she", "you", "it", "everyone", "nobody", "someone", "each", "all", "the", "our", "this", "that"]);
// A condition or a second clause means the sentence says more than "X owns Y" — unsure, so no.
const HEDGED = new RegExp(String.raw`[;:]|\b(?:except|but|unless|while|when|if|until|${OWN_VERBS}|go(?:es)? to)\b`, "i");

/** "Sean handles fleet and golf-estate deals" → who: "sean", topics: ["fleet", "golf-estate"]. */
function ownership(text: string): { who: string; topics: string[] } | null {
  const sentence = text.trim().replace(/[.!]+$/, "").replace(/^only /i, "");
  const first = OWNER_FIRST.exec(sentence);
  const last = first ? null : OWNER_LAST.exec(sentence);
  const [who, topic] = first ? [first[1], first[2]] : last ? [last[2], last[1]] : [];
  if (!who || !topic || NOT_A_NAME.has(who.toLowerCase()) || HEDGED.test(topic)) return null;
  const topics = topic.split(/\s*(?:,|&|\/|\band\b|\bor\b)\s*/i).map((item) => {
    const specific = [...words(item).content].filter((w) => !GENERIC.has(w)).sort();
    return specific.length ? specific.join(" ") : "*"; // only generic words: "all deals"
  });
  // First name only, so "Sean" and "Sean Tunley" are one person.
  return { who: who.split(" ")[0].toLowerCase(), topics };
}

/** True only when `next` clearly contradicts `existing` (see the two shapes above). */
export function conflictsWith(next: string, existing: string): boolean {
  const a = ownership(next);
  const b = ownership(existing);
  if (a && b) return a.who !== b.who && a.topics.some((t) => b.topics.includes(t));
  const x = words(next);
  const y = words(existing);
  if (!x.content.size || !sameSet(x.content, y.content)) return false;
  return x.negative !== y.negative || (x.numbers.size > 0 && y.numbers.size > 0 && !sameSet(x.numbers, y.numbers));
}

/* ── Nightly tidy-up (Hermes' periodic consolidation) ───────────────────── */

/**
 * Once a day the assistant re-reads everything it has learned, with the day's
 * questions as evidence, and proposes housekeeping: merge duplicates, drop what's
 * stale or trivial, flag what contradicts something else, and improve or add a
 * playbook from repeated corrections. Like everything it learns on its own, the
 * result lands UNREVIEWED; approved entries are never changed (only flagged).
 */
export const TIDY_INSTRUCTIONS = [
  "You keep a sales assistant's memory tidy. Below are the entries it has learned (id, kind, status, text) and today's questions people asked it.",
  "Output JSON only:",
  '{"merge":[{"ids":["<id>","<id>"],"content":"<one entry saying it once>"}],"remove":[{"id":"<id>","reason":"<why>"}],"flag":[{"id":"<id>","reason":"<what it contradicts>"}],"playbook":[{"name":"lowercase-name","description":"<=60 chars","content":"..."}]}',
  "- merge: entries of the SAME kind (and same person, for profile) that say the same thing. Keep every fact; say it once.",
  "- remove: entries that are stale, trivial, about one particular customer, or no longer true given the questions.",
  "- flag: an entry that contradicts another entry or today's questions — the owner will decide.",
  "- playbook: improve an existing one or add a new one ONLY when today's questions show the same correction or procedure more than once.",
  "- Answers rated wrong (with the reason: wrong_facts, bad_advice, misunderstood): when two or more share a cause you can see — a term it misread, a lookup it should have used, advice people keep rejecting — add or improve a playbook that prevents it. One bad answer alone is not a pattern. Flag an entry that led to a wrong answer.",
  "- You may only merge or remove entries whose status is unreviewed. Approved entries are the owner's: flag them at most.",
  "- Never include phone numbers, email addresses or customer names. Never invent facts.",
  'If nothing needs doing, output {}.',
].join("\n");

export const tidyBlock = z
  .object({
    merge: z.array(z.object({ ids: z.array(z.string().min(1).max(40)).min(2).max(6), content: entryText }).strict()).max(10).optional(),
    remove: z.array(z.object({ id: z.string().min(1).max(40), reason: z.string().max(200).optional() }).strict()).max(20).optional(),
    flag: z.array(z.object({ id: z.string().min(1).max(40), reason: z.string().trim().min(3).max(120) }).strict()).max(10).optional(),
    playbook: z.array(playbookOp).max(3).optional(),
  })
  .strict();
export type TidyBlock = z.infer<typeof tidyBlock>;

/** createdById: whose conversation it came from (null = the tidy-up itself). */
export type TidyEntry = { id: string; kind: string; userId: string | null; createdById: string | null; content: string; status: string };
export type TidyChange =
  | { kind: "merge"; keepId: string; deleteIds: string[]; content: string }
  | { kind: "remove"; id: string }
  | { kind: "flag"; id: string; reason: string };

/** The model's reply → a validated block, or null. */
export function parseTidy(reply: string): TidyBlock | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  try {
    const parsed = tidyBlock.safeParse(JSON.parse(reply.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Proposals → changes the server will make. Every id must exist; merges and
 * removals only touch UNREVIEWED entries (approved ones are the owner's), a merge
 * stays within one kind and one person and may not grow the text, flags only go
 * on memory/profile entries, and no entry is used twice.
 */
export function planTidy(entries: TidyEntry[], block: TidyBlock): TidyChange[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const used = new Set<string>();
  const changes: TidyChange[] = [];
  const free = (id: string) => byId.has(id) && !used.has(id);

  for (const merge of block.merge ?? []) {
    const ids = [...new Set(merge.ids)];
    if (ids.length < 2 || !ids.every(free)) continue;
    const group = ids.map((id) => byId.get(id)!);
    const [first] = group;
    if (first.kind === "playbook") continue;
    // Same kind, same person, and learned from the same person's conversations:
    // merging two people's unreviewed entries would hand each the other's.
    if (!group.every((e) => e.status !== "approved" && e.kind === first.kind && e.userId === first.userId && e.createdById === first.createdById)) continue;
    const scanned = scanEntry(merge.content);
    if (!scanned.ok || scanned.text.length > group.reduce((n, e) => n + e.content.length, 0)) continue;
    ids.forEach((id) => used.add(id));
    changes.push({ kind: "merge", keepId: first.id, deleteIds: ids.slice(1), content: scanned.text });
  }
  for (const { id } of block.remove ?? []) {
    if (!free(id) || byId.get(id)!.status === "approved") continue;
    used.add(id);
    changes.push({ kind: "remove", id });
  }
  for (const { id, reason } of block.flag ?? []) {
    const entry = byId.get(id);
    if (!entry || !free(id) || entry.kind === "playbook") continue;
    const scanned = scanEntry(reason);
    if (!scanned.ok) continue;
    used.add(id);
    changes.push({ kind: "flag", id, reason: scanned.text });
  }
  return changes;
}

/** The marker a flagged memory/profile entry carries in its (otherwise unused) description. */
export const FLAG_PREFIX = "⚠ ";

/** The learned block for the prompt — unreviewed entries marked so the model weighs them. */
/**
 * Playbooks this small go into the prompt in full: loading one with the
 * playbook tool costs a whole research round (~5 s) before the real search.
 * Past this, only the index — the full set would crowd the prompt.
 */
export const PLAYBOOK_INLINE_CHARS = 3000;

export function memoryPrompt(input: {
  memory: Entry[];
  profile: Entry[];
  playbooks: { name: string; description: string; status: string; content?: string }[];
}): string {
  const mark = (e: { status: string }) => (e.status === "approved" ? "" : " (unreviewed)");
  // A time-bound rule says so, or the model would state "for October" as for good.
  const until = (e: Entry) => (e.validUntil ? ` (until ${e.validUntil.toISOString().slice(0, 10)})` : "");
  const parts: string[] = [];
  if (input.memory.length) parts.push(`What you know about this business:\n${input.memory.map((e) => `- ${e.content}${until(e)}${mark(e)}`).join("\n")}`);
  if (input.profile.length) parts.push(`What you know about this person:\n${input.profile.map((e) => `- ${e.content}${until(e)}${mark(e)}`).join("\n")}`);
  if (input.playbooks.length) {
    const inline = input.playbooks.reduce((n, p) => n + (p.content?.length ?? Infinity), 0) <= PLAYBOOK_INLINE_CHARS;
    parts.push(
      inline
        ? `Playbooks you've learned — already loaded below, so follow the one that fits without loading it:\n${input.playbooks.map((p) => `- ${p.name}: ${p.description}${mark(p)}\n  ${p.content}`).join("\n")}`
        : `Playbooks you've learned (load one with the playbook tool when relevant):\n${input.playbooks.map((p) => `- ${p.name}: ${p.description}${mark(p)}`).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}
