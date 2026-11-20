/**
 * Getting what DAX learned in front of the owner (Sean, 2026-11-20: "ours gets buried somewhere" — it learned 3 times in
 * ~190 questions and nobody was told; the review list sat folded at the bottom of Settings → Assistant). Pure, so it is
 * tested without a database: the lines, the morning brief's "To review" section and the WhatsApp replies to it.
 * The database half is lib/assistantLearnedReview.ts.
 */

/** status: "unreviewed", or "conflict" — held because it contradicts an approved entry; that choice is made in Settings. */
export type LearnedItem = { id: string; kind: string; name: string | null; description: string | null; content: string; status?: string };

/** At most this many in one brief: the rest wait for the next one, or Settings. */
export const REVIEW_IN_BRIEF = 5;
/** Which brief offered what: per owner, a workspace setting ({ ids, at }), so "keep 2" means the brief they read. */
export const reviewOfferKey = (userId: string) => `ASSISTANT_REVIEW_OFFER:${userId}`;
/** A reply to a brief older than this doesn't count: the numbers may mean something else by now. */
export const REVIEW_OFFER_DAYS = 3;

const KIND_LABEL: Record<string, string> = { memory: "About the business", profile: "About a team member", playbook: "Playbook" };

/** One learned entry as one line: what kind, and what it says (a playbook by its name and description). */
export function learnedLine(note: LearnedItem, max = 160): string {
  const text = note.kind === "playbook" && note.name
    ? `“${note.name}”${note.description ? ` — ${note.description}` : ""}`
    : note.content;
  const flat = text.replace(/\s+/g, " ").trim();
  return `${KIND_LABEL[note.kind] ?? "Learned"}: ${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}`;
}

/** The morning brief's closing section for the owner — empty when nothing waits. Numbered as the replies use them. */
export function reviewSection(items: LearnedItem[], total: number): string {
  if (!items.length) return "";
  const more = total - items.length;
  return [
    "",
    `🧠 To review — what DAX learned (${total})`,
    ...items.map((item, i) => `${i + 1}. ${learnedLine(item)}`),
    ...(more > 0 ? [`…and ${more} more in Settings → Assistant.`] : []),
    "On WhatsApp, reply “keep 1”, “drop 2”, “keep all” or “drop all” — or review them in Settings → Assistant. Until you keep one, only the person it came from gets it.",
  ].join("\n");
}

export type ReviewReply = { verdict: "keep" | "drop"; which: "all" | number[] };

/**
 * "keep 1", "Drop 2 and 3", "keep 1,3", "keep all" → what to do; anything else → null (it is a question for DAX).
 * Strict on purpose: only a whole message that is exactly this, so a real question is never taken for a reply.
 */
export function parseReviewReply(text: string): ReviewReply | null {
  // Single digits (a brief lists at most REVIEW_IN_BRIEF), each set apart by a comma, "and", "&" or a space: "123" is
  // nothing, never "12 and 3".
  const match = /^\s*(keep|drop)\s+(all|[1-9](?:(?:\s*(?:,|and|&)\s*|\s+)[1-9])*)\s*[.!]?\s*$/i.exec(text);
  if (!match) return null;
  const verdict = match[1].toLowerCase() as "keep" | "drop";
  if (match[2].toLowerCase() === "all") return { verdict, which: "all" };
  const numbers = [...new Set((match[2].match(/[1-9]/g) ?? []).map(Number))];
  return numbers.length ? { verdict, which: numbers } : null;
}

export type ReviewOffer = { ids: string[]; at: string };

/** A stored offer, read defensively; null when missing, malformed or too old. */
export function readOffer(raw: string | null | undefined, now: Date): ReviewOffer | null {
  try {
    const offer = JSON.parse(raw ?? "") as Partial<ReviewOffer>;
    if (!Array.isArray(offer.ids) || !offer.ids.every((id) => typeof id === "string") || typeof offer.at !== "string") return null;
    const at = Date.parse(offer.at);
    if (!Number.isFinite(at) || now.getTime() - at > REVIEW_OFFER_DAYS * 86_400_000) return null;
    return { ids: offer.ids, at: offer.at };
  } catch {
    return null;
  }
}

/** The ids a reply means, from the offer it answers; numbers outside the list are named back, never guessed. */
export function idsFor(reply: ReviewReply, offer: ReviewOffer): { ids: string[]; unknown: number[] } {
  if (reply.which === "all") return { ids: offer.ids, unknown: [] };
  return {
    ids: reply.which.filter((n) => n <= offer.ids.length).map((n) => offer.ids[n - 1]),
    unknown: reply.which.filter((n) => n > offer.ids.length),
  };
}
