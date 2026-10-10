/**
 * Incoming-message screening — the part that needs no database and no model.
 *
 * Everything here is a pure function of what it is handed, so the policy can be
 * read, tested and changed in one place. The order of the checks in
 * {@link decideByRules} IS the policy:
 *
 *   1. a person's standing decision about the sender (block, then allow)
 *   2. nothing readable → not enough evidence, never spam
 *   3. a real relationship with this workspace → a customer, never screened out
 *   4. wording a person has confirmed as spam before (small variations included)
 *   5. a link domain an owner has switched on as a spam rule
 *   6. the same message hammered at machine speed by a stranger
 *   7. otherwise: undecided — ask the classifier, within its budget
 *
 * Deliberately absent: message length, spelling, language, country code, emoji
 * and attachments. None of them is evidence of spam on its own.
 */

export const SCREENING_POLICY_VERSION = "2026-10-11.1";

export type ScreeningClass = "sales_enquiry" | "customer_support" | "business_approach" | "uncertain" | "spam";
export const SCREENING_CLASSES: ScreeningClass[] = ["sales_enquiry", "customer_support", "business_approach", "uncertain", "spam"];
export type ScreeningMode = "off" | "observe" | "quarantine";
export type SenderRule = "allow" | "block" | null;

export const CLASS_LABEL: Record<ScreeningClass, string> = {
  sales_enquiry: "Sales enquiry",
  customer_support: "Existing customer / support",
  business_approach: "Business approach",
  uncertain: "Uncertain",
  spam: "Spam / scam",
};

/** What a workspace can tune. Stored as JSON in the INBOUND_SCREENING_POLICY setting. */
export type ScreeningPolicy = {
  /** How alike (0–1) a message must be to wording confirmed as spam. */
  repeatSimilarity: number;
  /** A message shorter than this many words is never matched as a repeat ("hi", "price?"). */
  repeatMinWords: number;
  /** Messages from one unknown sender inside the burst window that count as a burst. */
  burstCount: number;
  burstWindowSeconds: number;
  /** May the classifier's verdict alone quarantine? "strong" = only with a strong reason code and no stated uncertainty. */
  aiQuarantine: "strong" | "never";
  /** Classifier calls allowed per sender per hour, and per workspace per day. */
  aiPerSenderPerHour: number;
  aiPerWorkspacePerDay: number;
  aiTimeoutMs: number;
};

export const DEFAULT_POLICY: ScreeningPolicy = {
  repeatSimilarity: 0.8,
  repeatMinWords: 6,
  burstCount: 8,
  burstWindowSeconds: 60,
  aiQuarantine: "strong",
  aiPerSenderPerHour: 4,
  aiPerWorkspacePerDay: 400,
  aiTimeoutMs: 6000,
};

const between = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** A stored policy is untrusted input like any other setting: every field is range-checked. */
export function parsePolicy(raw: string | null | undefined): ScreeningPolicy {
  let p: Record<string, unknown> = {};
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) p = parsed;
  } catch { /* keep the defaults */ }
  const d = DEFAULT_POLICY;
  return {
    repeatSimilarity: between(p.repeatSimilarity, 0.6, 1, d.repeatSimilarity),
    repeatMinWords: Math.round(between(p.repeatMinWords, 4, 30, d.repeatMinWords)),
    burstCount: Math.round(between(p.burstCount, 3, 100, d.burstCount)),
    burstWindowSeconds: Math.round(between(p.burstWindowSeconds, 10, 3600, d.burstWindowSeconds)),
    aiQuarantine: p.aiQuarantine === "never" ? "never" : "strong",
    aiPerSenderPerHour: Math.round(between(p.aiPerSenderPerHour, 0, 50, d.aiPerSenderPerHour)),
    aiPerWorkspacePerDay: Math.round(between(p.aiPerWorkspacePerDay, 0, 20000, d.aiPerWorkspacePerDay)),
    aiTimeoutMs: Math.round(between(p.aiTimeoutMs, 1000, 15000, d.aiTimeoutMs)),
  };
}

export function parseMode(raw: string | null | undefined): ScreeningMode {
  return raw === "observe" || raw === "quarantine" ? raw : "off";
}

/* ── text ─────────────────────────────────────────────────────────────── */

// A link: with a scheme or "www.", OR a bare domain followed by a path ("login.example.help/x"), OR a bare domain on a common ending.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s<>"']*|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|info|biz|xyz|top|link|click|site|online|shop|live|app|me|ly|gg|ru|cn|za|uk)(?:\/[^\s<>"']*)?/gi;

/** The domains a message links to, lower-cased, without "www." — read from the text, never fetched. */
export function extractDomains(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.match(URL_RE) ?? []) {
    const host = match.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#:]/)[0].toLowerCase().replace(/\.+$/, "");
    if (host.includes(".")) out.add(host);
  }
  return [...out];
}

/**
 * A message reduced to what a campaign keeps constant: lower case, links
 * replaced by their domain, every number by "#", punctuation and emoji gone.
 * "Dear user 4471, your account…" and "dear user 9902 — your account!!" are the
 * same wording.
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(URL_RE, (m) => ` ${m.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#:]/)[0]} `)
    .replace(/\d+/g, "#")
    .replace(/[^\p{L}\p{N}#.\s]/gu, " ")
    // A full stop ends a sentence; only the dots inside a domain are kept.
    .replace(/\.+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

const words = (normalized: string) => normalized.split(" ").filter(Boolean);

function shingles(normalized: string): Set<string> {
  const w = words(normalized);
  const out = new Set<string>();
  if (w.length < 3) { if (w.length) out.add(w.join(" ")); return out; }
  for (let i = 0; i + 3 <= w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}

/** 0–1: how much of their three-word runs two normalised texts share (Jaccard). */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const sa = shingles(a), sb = shingles(b);
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared += 1;
  const union = sa.size + sb.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** A link shown to staff must not be clickable or auto-previewed: "example.com" → "example[.]com". */
export function inertPreview(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return cut.replace(/https?:\/\//gi, "hxxp://").replace(/\.(?=[a-z0-9-]{2,}(?:[/\s.:?#]|$))/gi, "[.]");
}

/* ── the decision ─────────────────────────────────────────────────────── */

/** Facts about the sender's standing with THIS workspace. A contact row alone is none of them. */
export type Relationship = {
  /** A person on staff has written to them on this channel recently. */
  staffReplied: boolean;
  /** A quote that is out or accepted. */
  activeQuote: boolean;
  /** A job card / service record. */
  serviceRecord: boolean;
  /** A booking: test drive or planned appointment. */
  booking: boolean;
};
// Not here on purpose: "has a lead". An ad click opens a lead automatically, so a lead proves no more than a contact does.
export const NO_RELATIONSHIP: Relationship = { staffReplied: false, activeQuote: false, serviceRecord: false, booking: false };
export const relationshipSignals = (r: Relationship): string[] =>
  (Object.keys(r) as (keyof Relationship)[]).filter((k) => r[k]).map((k) => `rel_${k}`);

export type RuleInput = {
  text: string;
  senderRule: SenderRule;
  relationship: Relationship;
  /** Normalised wording people have confirmed as spam in this workspace (newest first, bounded by the caller). */
  confirmedSpam: string[];
  /** Normalised wording an owner has switched on as a rule. */
  activeTextPatterns: string[];
  /** Link domains an owner has switched on as a rule. */
  activeDomains: string[];
  /** This sender's own messages inside the burst window, normalised (this one excluded). */
  recentFromSender: string[];
  policy: ScreeningPolicy;
};

export type RuleVerdict =
  | { outcome: "quarantine"; decidedBy: "sender_block" | "rule"; classification: ScreeningClass; reasonCodes: string[]; reason: string }
  | { outcome: "admit"; decidedBy: "sender_allow" | "relationship" | "rule"; classification: ScreeningClass; uncertain: boolean; reasonCodes: string[]; reason: string }
  | { outcome: "undecided"; reasonCodes: string[] };

export function decideByRules(input: RuleInput): RuleVerdict {
  const { policy } = input;
  // 1. A person's decision about this sender outranks everything, and needs no model.
  if (input.senderRule === "block") {
    return { outcome: "quarantine", decidedBy: "sender_block", classification: "uncertain", reasonCodes: ["sender_blocked"], reason: "You blocked this sender." };
  }
  if (input.senderRule === "allow") {
    return { outcome: "admit", decidedBy: "sender_allow", classification: "uncertain", uncertain: false, reasonCodes: ["sender_allowed"], reason: "You always allow this sender." };
  }

  const normalized = normalizeText(input.text);
  // 2. No readable text (a photo, a voice note that could not be heard): not enough to judge.
  if (!normalized) {
    return { outcome: "admit", decidedBy: "rule", classification: "uncertain", uncertain: true, reasonCodes: ["no_readable_text"], reason: "Nothing readable to judge — let through." };
  }

  // 3. Somebody this workspace is already dealing with.
  const signals = relationshipSignals(input.relationship);
  if (signals.length > 0) {
    return { outcome: "admit", decidedBy: "relationship", classification: "customer_support", uncertain: false, reasonCodes: signals, reason: "Someone you are already dealing with." };
  }

  // 4 + 5. Wording or a link domain already confirmed as spam.
  const longEnough = words(normalized).length >= policy.repeatMinWords;
  if (longEnough) {
    if (input.activeTextPatterns.some((p) => similarity(normalized, p) >= policy.repeatSimilarity)) {
      return { outcome: "quarantine", decidedBy: "rule", classification: "spam", reasonCodes: ["matches_spam_rule"], reason: "Matches a spam rule you switched on." };
    }
    if (input.confirmedSpam.some((p) => similarity(normalized, p) >= policy.repeatSimilarity)) {
      return { outcome: "quarantine", decidedBy: "rule", classification: "spam", reasonCodes: ["repeat_of_confirmed_spam"], reason: "Almost identical to a message you marked as spam." };
    }
  }
  const domains = extractDomains(input.text);
  const badDomain = domains.find((d) => input.activeDomains.some((bad) => d === bad || d.endsWith(`.${bad}`)));
  if (badDomain) {
    return { outcome: "quarantine", decidedBy: "rule", classification: "spam", reasonCodes: ["spam_link_domain"], reason: "Links to a site you set as a spam rule." };
  }

  // 6. A burst: many messages in the window AND they say the same thing. Volume
  //    alone is not it — an excited customer sends ten different lines.
  if (longEnough && input.recentFromSender.length + 1 >= policy.burstCount) {
    const same = input.recentFromSender.filter((p) => similarity(normalized, p) >= policy.repeatSimilarity).length;
    if (same + 1 >= Math.ceil(policy.burstCount * 0.75)) {
      return { outcome: "quarantine", decidedBy: "rule", classification: "spam", reasonCodes: ["repeated_burst"], reason: "The same message, sent over and over within a minute." };
    }
  }

  return { outcome: "undecided", reasonCodes: domains.length ? ["has_link"] : [] };
}

/* ── the classifier's answer ──────────────────────────────────────────── */

/** Reason codes the classifier may give. Anything else is dropped. */
export const REASON_CODES = [
  "asks_price_or_product", "asks_booking_or_test_drive", "asks_service_or_warranty", "complaint", "unsubscribe_request",
  "wants_human", "greeting_only", "question_outside_scope", "supplier_or_partnership_offer", "job_seeker_or_media",
  "fake_platform_or_account_notice", "phishing_or_credential_request", "advance_fee_or_prize", "investment_or_crypto_scheme",
  "unsolicited_bulk_promotion", "impersonation", "adult_or_gambling_promotion", "instructs_the_classifier", "too_little_to_tell",
] as const;
const REASON_SET = new Set<string>(REASON_CODES);

/** Only these, with no stated uncertainty, may quarantine on the classifier's word alone. */
export const STRONG_SPAM_REASONS = new Set<string>([
  "fake_platform_or_account_notice", "phishing_or_credential_request", "advance_fee_or_prize", "investment_or_crypto_scheme",
  "unsolicited_bulk_promotion", "impersonation", "adult_or_gambling_promotion",
]);

/** A genuine-looking reason beside "spam" means the model contradicted itself: never quarantine on that. */
const PROTECTED_REASONS = new Set<string>([
  "asks_price_or_product", "asks_booking_or_test_drive", "asks_service_or_warranty", "complaint", "unsubscribe_request",
  "wants_human", "greeting_only", "question_outside_scope", "supplier_or_partnership_offer",
]);

export const REASON_TEXT: Record<string, string> = {
  asks_price_or_product: "Asks about a price or product",
  asks_booking_or_test_drive: "Asks to book or test-drive",
  asks_service_or_warranty: "Asks about service or warranty",
  complaint: "A complaint",
  unsubscribe_request: "Asks to stop messages",
  wants_human: "Asks for a person",
  greeting_only: "Just a greeting",
  question_outside_scope: "A question the bot can't answer",
  supplier_or_partnership_offer: "A supplier or partnership offer",
  job_seeker_or_media: "A job seeker or the media",
  fake_platform_or_account_notice: "Fake “your account will be suspended” notice",
  phishing_or_credential_request: "Asks for a password, code or login",
  advance_fee_or_prize: "Prize, inheritance or pay-first scam",
  investment_or_crypto_scheme: "Investment or crypto scheme",
  unsolicited_bulk_promotion: "Unsolicited bulk promotion",
  impersonation: "Pretends to be someone official",
  adult_or_gambling_promotion: "Adult or gambling promotion",
  instructs_the_classifier: "Tries to tell the filter what to do",
  too_little_to_tell: "Too little to tell",
  sender_blocked: "You blocked this sender",
  sender_allowed: "You always allow this sender",
  no_readable_text: "Nothing readable to judge",
  matches_spam_rule: "Matches a spam rule you switched on",
  repeat_of_confirmed_spam: "Almost identical to a message marked as spam",
  spam_link_domain: "Links to a site set as a spam rule",
  repeated_burst: "Same message sent over and over",
  has_link: "Contains a link",
  recent_genuine_exchange: "Continues a conversation already let through",
  classifier_unavailable: "The filter could not check this one",
  classifier_budget: "The filter's checking limit was reached",
  marked_by_staff: "Marked by a person",
  rel_staffReplied: "Staff have replied to them",
  rel_activeQuote: "Has an active quote",
  rel_serviceRecord: "Has a service record",
  rel_booking: "Has a booking",
};
export const reasonText = (codes: string[], fallback = ""): string =>
  codes.map((c) => REASON_TEXT[c]).filter(Boolean).slice(0, 2).join(" · ") || fallback;

export type AiVerdict = { classification: ScreeningClass; reasonCodes: string[]; uncertain: boolean };

/** The classifier's reply is untrusted too: exactly one JSON object, known values only, or nothing. */
export function parseAiVerdict(text: string): AiVerdict | null {
  let raw: unknown;
  try { raw = JSON.parse(text.trim()); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.classification !== "string" || !SCREENING_CLASSES.includes(o.classification as ScreeningClass)) return null;
  if (typeof o.uncertain !== "boolean" || !Array.isArray(o.reasonCodes)) return null;
  const reasonCodes = [...new Set(o.reasonCodes.filter((c): c is string => typeof c === "string" && REASON_SET.has(c)))].slice(0, 4);
  return { classification: o.classification as ScreeningClass, reasonCodes, uncertain: o.uncertain };
}

/** Does the classifier's verdict, on its own, justify quarantine under this policy? */
export function aiMayQuarantine(verdict: AiVerdict, policy: ScreeningPolicy): boolean {
  if (policy.aiQuarantine === "never") return false;
  if (verdict.classification !== "spam" || verdict.uncertain) return false;
  if (verdict.reasonCodes.some((c) => PROTECTED_REASONS.has(c))) return false;
  return verdict.reasonCodes.some((c) => STRONG_SPAM_REASONS.has(c));
}
