import type { FlowChannel } from "./flowValidation";

export const FLOW_CHANNELS: readonly FlowChannel[] = ["whatsapp", "messenger", "instagram", "telegram"];
/** `comment`: a keyword in a comment on the Instagram account's post (Instagram follow gate, 2026-11-21). Instagram only. */
export const FLOW_ROUTE_KINDS = ["keyword", "referral", "ad", "comment"] as const;
export type FlowRouteKind = (typeof FLOW_ROUTE_KINDS)[number];

/** Which channels a route kind can be set up on. */
export function routeKindAllowed(kind: FlowRouteKind, channel: string): boolean {
  return kind === "comment" ? channel === "instagram" : true;
}

export type FlowEntryContext = {
  text?: string | null;
  referralRef?: string | null;
  adId?: string | null;
  source?: string | null;
  /** The text of an Instagram comment that is starting a flow (lib/instagramCommentFlow.ts). */
  commentText?: string | null;
};

export type MatchableFlowRoute = { kind: string; pattern: string };

export function normalizeRoutePattern(value: string): string {
  return value.toLocaleLowerCase("en-ZA").replace(/\s+/g, " ").trim().slice(0, 180);
}

function normalizeInboundRouteValue(value: string): string {
  return value.toLocaleLowerCase("en-ZA").replace(/\s+/g, " ").trim();
}

export function routeMatches(route: MatchableFlowRoute, entry: FlowEntryContext): boolean {
  const pattern = normalizeRoutePattern(route.pattern);
  if (!pattern) return false;
  if (route.kind === "keyword" || route.kind === "comment") {
    // The phrase anywhere in the message — or, for a comment route, anywhere in the comment ("GUIDE please 💛").
    const source = route.kind === "comment" ? entry.commentText : entry.text;
    const text = ` ${normalizeInboundRouteValue(source ?? "").replace(/[^a-z0-9]+/g, " ").trim()} `;
    const phrase = ` ${pattern.replace(/[^a-z0-9]+/g, " ").trim()} `;
    return phrase.trim().length >= 2 && text.includes(phrase);
  }
  if (route.kind === "referral") return normalizeInboundRouteValue(entry.referralRef ?? "") === pattern;
  if (route.kind === "ad") return normalizeInboundRouteValue(entry.adId ?? "") === pattern;
  return false;
}

/**
 * The WHOLE message is a keyword route's phrase — what a QR scan sends. Stricter than routeMatches (which finds the
 * phrase anywhere): it is used to restart a conversation waiting for a person, so "can you resend the brochure?" must
 * not count, but the poster's exact pre-filled message must.
 */
export function routeIsWholeMessage(route: MatchableFlowRoute, text: string): boolean {
  if (route.kind !== "keyword") return false;
  const words = (value: string) => normalizeInboundRouteValue(value).replace(/[^a-z0-9]+/g, " ").trim();
  const phrase = words(route.pattern);
  return phrase.length >= 2 && words(text) === phrase;
}
