import type { FlowChannel } from "./flowValidation";

export const FLOW_CHANNELS: readonly FlowChannel[] = ["whatsapp", "messenger", "instagram", "telegram"];
export const FLOW_ROUTE_KINDS = ["keyword", "referral", "ad"] as const;
export type FlowRouteKind = (typeof FLOW_ROUTE_KINDS)[number];

export type FlowEntryContext = {
  text?: string | null;
  referralRef?: string | null;
  adId?: string | null;
  source?: string | null;
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
  if (route.kind === "keyword") {
    const text = ` ${normalizeInboundRouteValue(entry.text ?? "").replace(/[^a-z0-9]+/g, " ").trim()} `;
    const phrase = ` ${pattern.replace(/[^a-z0-9]+/g, " ").trim()} `;
    return phrase.trim().length >= 2 && text.includes(phrase);
  }
  if (route.kind === "referral") return normalizeInboundRouteValue(entry.referralRef ?? "") === pattern;
  if (route.kind === "ad") return normalizeInboundRouteValue(entry.adId ?? "") === pattern;
  return false;
}
