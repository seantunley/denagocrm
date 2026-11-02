import { z } from "zod";

/**
 * "DRAFT A WHATSAPP FOR THE FOURTH ONE" — the records an answer LISTED, in the order the person read them.
 *
 * The next question used to get the working memory (customer, topic, decided, open) and the last three exchanges
 * cut to 400 characters each, so the fourth of five quotes was often simply gone. Now every answer keeps the
 * records it named, in order, on its turn (AssistantTurn.state.listed — no new column), and the next question gets
 * them back, numbered.
 *
 * Only records THIS answer's own lookups returned (their `link`), never an id the model wrote: the order is where
 * each first appears in the answer — its [[/link]] citation, its quote number, or its name. On the way back each
 * one is checked again against what the person may open NOW (assistantListed.listedNow): a place they lost stays
 * numbered but empty, so "the fourth one" never slides onto the fifth.
 *
 * Kept apart from the WhatsApp waiting-task list (numbered tasks): this is records shown in an answer.
 */

export type ListedKind = "lead" | "quote" | "contact" | "vehicle" | "jobcard";
export type ListedRecord = { kind: ListedKind; id: string; label: string };
/**
 * A place on the list as it is now: the record, or — where this person can no longer open it — only the KIND it
 * was (no id, no name). The kind stays so "the first quote" still counts it: a lost quote is never skipped over
 * onto the next one (review of #947).
 */
export type GoneSlot = { kind: ListedKind; gone: true };
export type ListedSlot = ListedRecord | GoneSlot;
export const isGone = (slot: ListedSlot | undefined): slot is GoneSlot => Boolean(slot && "gone" in slot);

export const MAX_LISTED = 10;

const LINK = /^\/(leads|quotes|contacts|vehicles|jobcards)\/([\w-]{1,64})$/;
const KIND: Record<string, ListedKind> = { leads: "lead", quotes: "quote", contacts: "contact", vehicles: "vehicle", jobcards: "jobcard" };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const text = (v: unknown) => (typeof v === "string" && v.trim().length >= 3 ? v.trim() : null);

/** Where `pattern` first appears in the answer as a whole word (or link), else -1. */
function firstAt(answer: string, pattern: string): number {
  return new RegExp(`(?<![\\p{L}\\p{N}/])${pattern}(?![\\p{L}\\p{N}_-])`, "iu").exec(answer)?.index ?? -1;
}

/**
 * The records the answer named, in the order it named them, at most MAX_LISTED. `data`: this answer's lookups as
 * returned. Each record is placed by its MOST specific mention that is there — its link, then its quote number
 * (a quote is placed by nothing else), then its name — and one record per place: the deal and the customer record
 * behind the same name are one line to the person reading.
 */
export function listedRecords(answer: string, data: unknown[]): ListedRecord[] {
  const found = new Map<string, { record: ListedRecord; at: number }>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    const o = value as Record<string, unknown>;
    const link = typeof o.link === "string" ? LINK.exec(o.link) : null;
    if (link) {
      const kind = KIND[link[1]];
      const number = kind === "quote" && typeof o.quote === "string" ? /^Q-?(\d{1,9})$/i.exec(o.quote)?.[1] : undefined;
      const name = text(o.customer) ?? text(o.name) ?? text(o.reg) ?? text(o.title) ?? text(o.vehicle);
      const patterns = [esc(o.link as string), ...(number ? [`Q-?${number}`] : kind === "quote" ? [] : name ? [esc(name)] : [])];
      const at = patterns.map((p) => firstAt(answer, p)).find((i) => i >= 0) ?? -1;
      const key = `${kind}:${link[2]}`;
      const before = found.get(key);
      if (at >= 0 && (!before || at < before.at)) {
        const deal = text(o.lead);
        const label = number ? `Q-${number}${name ? ` · ${name}` : ""}` : `${name ?? "record"}${deal && deal !== name ? ` — ${deal}` : ""}`;
        found.set(key, { record: { kind, id: link[2], label: label.slice(0, 80) }, at });
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  };
  walk(data);
  const places = new Set<number>();
  return [...found.values()]
    .sort((a, b) => a.at - b.at)
    .filter(({ at }) => !places.has(at) && places.add(at))
    .slice(0, MAX_LISTED)
    .map(({ record }) => record);
}

const listedSchema = z.array(z.object({ kind: z.enum(["lead", "quote", "contact", "vehicle", "jobcard"]), id: z.string().regex(/^[\w-]{1,64}$/), label: z.string().max(80) }).strict()).max(MAX_LISTED);

/** A turn's saved state → its list (anything malformed: none), and the working memory without it. */
export function splitListed(state: unknown): { listed: ListedRecord[]; rest: Record<string, unknown> | null } {
  if (!state || typeof state !== "object" || Array.isArray(state)) return { listed: [], rest: null };
  const { listed, ...rest } = state as Record<string, unknown>;
  const parsed = listedSchema.safeParse(listed ?? []);
  return { listed: parsed.success ? parsed.data : [], rest: Object.keys(rest).length ? rest : null };
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const NUMBERS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const NOUNS: Record<string, ListedKind[] | null> = {
  one: null, record: null, item: null,
  quote: ["quote"], lead: ["lead", "contact"], deal: ["lead", "contact"], customer: ["lead", "contact"], client: ["lead", "contact"],
  vehicle: ["vehicle"], cart: ["vehicle"], "job card": ["jobcard"],
};
const NOUN = "(one|record|item|quote|lead|deal|customer|client|vehicle|cart|job card)";
const ORD = `(${ORDINALS.join("|")}|last|(?:10|[1-9])(?:st|nd|rd|th))`;
/** "the fourth one", "the 2nd quote", "the last one", "the third" (ending the clause), "number three", "no. 3", "#3". */
const PATTERNS = [
  new RegExp(`\\bthe\\s+${ORD}\\s+${NOUN}s?\\b`, "giu"),
  new RegExp(`\\bthe\\s+${ORD}(?=\\s*(?:[,.;!?]|$|\\s(?:on|in|from)\\s+(?:the|that|your)\\s+list|(?:and|or|&)\\s))`, "giu"),
  new RegExp(`(?:\\bnumber|\\bno\\.|#)\\s*(10|[1-9]|${NUMBERS.join("|")})\\b(?!\\s*(?:days?|weeks?|months?|units?|carts?|%))`, "giu"),
];

export type Reference = {
  /** The words in the question ("the fourth one"). */
  phrase: string;
  /** Every place on the list the words could mean (1-based), with what is there now. Empty: the list is shorter. */
  matches: { place: number; slot: ListedSlot }[];
};

/**
 * A plain place in the list — "the fourth one", "the 2nd quote", "the last one", "number three" — or null when the
 * question names none, or names two different places ("the first and the third": DAX reads the list itself). Only
 * the place is worked out here; anything fuzzier ("her other quote", "same for Donovan") goes to the model with
 * the list. A noun narrows it ("the second quote" among quotes); "one" over a list of deals AND quotes may mean
 * either, and both are returned so DAX asks which.
 */
export function resolveReference(question: string, slots: ListedSlot[]): Reference | null {
  if (!slots.length) return null;
  const hits = PATTERNS.flatMap((p) => [...question.matchAll(p)]).map((m) => {
    const word = m[1].toLowerCase();
    const n = word === "last" ? -1 : ORDINALS.includes(word) ? ORDINALS.indexOf(word) + 1 : NUMBERS.includes(word) ? NUMBERS.indexOf(word) + 1 : parseInt(word, 10);
    return { phrase: m[0].trim(), n, noun: m[2]?.toLowerCase() ?? "one" };
  });
  if (!hits.length || new Set(hits.map((h) => h.n)).size > 1) return null;
  const { phrase, n, noun } = hits[0];
  const places = slots.map((slot, i) => ({ place: i + 1, slot }));
  const kinds = NOUNS[noun] ?? null;
  // The place within one kind: among the quotes, "the second quote". A place a person lost keeps the kind it had,
  // so it is still counted — a lost record never shifts "the first quote" onto the one after it.
  const nth = (of: typeof places) => (n === -1 ? of.at(-1) : of[n - 1]);
  const ofKind = (ks: ListedKind[]) => places.filter((p) => ks.includes(p.slot.kind));
  const present = [...new Set(slots.map((s) => s.kind))];
  const candidates = kinds
    ? [nth(ofKind(kinds))]
    : present.length > 1
      ? [nth(places), ...present.map((k) => nth(ofKind([k])))]
      : [nth(places)];
  const matches = [...new Map(candidates.filter((c) => c !== undefined).map((c) => [c.place, c])).values()];
  return { phrase, matches };
}

const KIND_WORD: Record<ListedKind, string> = { lead: "deal", quote: "quote", contact: "customer", vehicle: "vehicle", jobcard: "job card" };
const line = ({ place, slot }: { place: number; slot: ListedSlot }) =>
  isGone(slot) ? `#${place} (no longer available to this person)` : `#${place} ${KIND_WORD[slot.kind]} ${slot.label} (id ${slot.id})`;

/** What DAX is told about this question's reference, if it has one. */
export function referenceLine(ref: Reference, count: number): string {
  const { phrase, matches } = ref;
  if (!matches.length) return `In the question, "${phrase}" points past the end of that list (it had ${count}). Say so and ask which one they mean.`;
  if (matches.length > 1) return `In the question, "${phrase}" could be ${matches.map(line).join(" or ")}. Ask ONE short question naming them; do not guess.`;
  const [m] = matches;
  if (isGone(m.slot)) return `In the question, "${phrase}" is #${m.place}, which this person can no longer open (reassigned, deleted or outside their access). Tell them so; never act on it and never swap in another record.`;
  return `In the question, "${phrase}" is ${line(m)}.`;
}

/**
 * The list as the research and answer steps read it (the caller fences it as data): numbered as the person saw it,
 * with the reading of this question's "the fourth one" when it has one. Ids are for LOOKING UP — the list is from
 * an earlier answer, so the record is looked up again (current facts, the person's access now) before it is used.
 */
export function listedBlock(slots: ListedSlot[], question: string): string {
  if (!slots.length) return "";
  const ref = resolveReference(question, slots);
  return [
    `The records DAX's earlier answer listed, in the order the person saw them. "The fourth one", "her other quote", "same for the next one" point here:`,
    ...slots.map((slot, i) => line({ place: i + 1, slot })),
    ref ? referenceLine(ref, slots.length) : "",
    "Before using one, look it up again (lead_brief with its id; a quote by its number with find_quotes) — this list is from earlier, and only a fresh lookup shows what is true now. Keep what the person already said (colour, date, wording). If two records genuinely fit what they said, ask one specific question naming both instead of guessing.",
  ].filter(Boolean).join("\n");
}
