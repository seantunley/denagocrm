import { isSmallTalk } from "./crmAssistantPlan";

/**
 * WHICH WAY A MESSAGE GOES, decided before anything is read (DAX conversational upgrades, item 3 — Sean 2026-11-14:
 * keep it conservative, only clear acknowledgements take the shortcut).
 *
 *  - "ack":     a clear thank-you — "Shot, thanks", "Cheers DAX 👍", "lekker, thank you!". Nothing to look up.
 *  - "wording": a wording-only change to the last answer or draft — "Make it warmer", "shorter please", "less salesy".
 *               Rewritten from the conversation; every figure, name and date kept (the answer rule says so, and the
 *               figure check re-runs the earlier lookups if a number is restated).
 *  - "chat":    the small talk DAX already skipped research for — hi, ok, 👍, "who are you?".
 *  - "full":    everything else — a question, a "?", a digit, a name, an instruction ("ok send it"), anything mixed
 *               ("Thanks, has she paid yet?"). The normal path, with its lookups.
 *
 * Only "full" reads the workspace's CRM context; the other three never research, so they don't need it.
 * A fresh photo always goes "full": the picture may change what the words mean.
 */
export type FollowUpRoute = "ack" | "wording" | "chat" | "full";

/** Words that thank — at least one must be there for "ack". SA English included. */
const THANKS = new Set(["thanks", "thank", "thx", "ta", "shot", "cheers", "appreciated", "lekker", "sharp", "legend", "dankie"]);
/** Words that may sit beside a thank-you without changing what it is. */
const WITH_THANKS = new Set(["you", "a", "lot", "much", "so", "very", "ok", "okay", "cool", "great", "nice", "perfect", "awesome", "brilliant", "noted", "got", "it", "dax"]);

/** Edits that change only the wording. Strict on purpose: anything else — a name, a product, a figure — goes "full". */
const WORDING =
  /^(?:(?:please|pls|can you|could you)\s+)?(?:(?:make|keep)\s+)?(?:(?:it|that|this|the (?:email|message|draft|whatsapp|reply|note))\s+)?(?:(?:a (?:bit|little|touch)|slightly|much|even|way)\s+)?(?:(?:more|less)\s+)?(warmer|friendlier|shorter|longer|softer|firmer|punchier|simpler|clearer|crisper|formal|casual|professional|polite|salesy|pushy|personal|friendly|direct|concise)(?:\s+please)?$/;
const WORDING_VERBS = /^(?:(?:please|pls|can you|could you)\s+)?(?:(?:shorten|soften|tighten|simplify|polish)\s+(?:it|that|this)|(?:tone|warm)\s+(?:it|that|this)\s+(?:down|up))(?:\s+(?:a (?:bit|little)|please))?$/;

/** The words of a name, lower case, letters only — "Jarvis" → ["jarvis"]. */
const nameWords = (name: string | undefined) => (name ?? "").toLowerCase().match(/\p{L}+/gu) ?? [];

/**
 * @param assistantName the workspace's own name for its assistant (Sean 2026-11-14: everything works when a workspace
 *   renames it). It counts like "DAX" — whole words, any case — and ONLY beside a bare thank-you or greeting: it never
 *   widens anything else, so a name that is also a common word or a customer's changes nothing but "Thanks <name>".
 */
export function followUpRoute(question: string, freshImages = false, assistantName?: string): FollowUpRoute {
  if (freshImages) return "full";
  const q = question.trim().toLowerCase();
  if (!q || /\d/.test(q)) return "full";
  const named = new Set(nameWords(assistantName));
  // Emoji and punctuation out; what's left must be words.
  const words = q.replace(/[\p{Extended_Pictographic}\p{Emoji_Component}]/gu, " ").replace(/[!.,…\-—–]+/g, " ").trim();
  if (!q.includes("?") && words) {
    const tokens = words.split(/\s+/);
    if (tokens.some((t) => THANKS.has(t)) && tokens.every((t) => THANKS.has(t) || WITH_THANKS.has(t) || named.has(t))) return "ack";
  }
  // A wording edit may be asked as a question ("can you make it shorter?") — only that one trailing "?".
  const edit = words.replace(/\?$/, "").trim();
  if (!edit.includes("?") && (WORDING.test(edit) || WORDING_VERBS.test(edit))) return "wording";
  if (isSmallTalk(question)) return "chat";
  // "Hi Jarvis!" — small talk once the assistant's own name is taken out; what remains must still be bare small talk.
  if (named.size) {
    const rest = question.trim().split(/\s+/).filter((w) => !named.has(nameWords(w).join(""))).join(" ").replace(/^[\s,]+/, "");
    if (rest && rest !== question.trim() && isSmallTalk(rest)) return "chat";
  }
  return "full";
}

/** For the run's timings (numbers only, never the words): which route each question took, to compare their speed. */
export const FOLLOW_UP_CODE: Record<FollowUpRoute, number> = { full: 0, ack: 1, wording: 2, chat: 3 };

/** Said to the answer step on a wording-only edit. */
export const WORDING_EDIT_RULE =
  "This is a WORDING-ONLY change to your last answer or draft in this conversation: rewrite it the way they asked. Keep every figure, amount, date, name, product, recipient and Cc exactly as it was, change nothing else, and add no new facts. Nothing was looked up for this — if they asked for something that needs the CRM, say so and they can ask it plainly.";
