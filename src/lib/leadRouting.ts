/**
 * Who a new INBOUND lead goes to — the pure half of lead routing.
 *
 * No database here: the caller (createInStage in leadCreate.ts) hands over the
 * set of reps who are still eligible RIGHT NOW (active, non-disabled members of
 * the lead's own workspace) and the last rep the rotation landed on, and gets a
 * decision back. Everything that can be wrong about a rule lives here, where a
 * test can execute it.
 */

/** AppSetting key for the workspace's routing config (JSON). */
export const LEAD_ROUTING_KEY = "LEAD_ROUTING";
/** AppSetting key for the round-robin pointer: the user id the rotation last landed on. */
export const LEAD_ROUTING_LAST_KEY = "LEAD_ROUTING_LAST";

export const ROUND_ROBIN = "round_robin";

export type LeadRoutingRule = {
  /** Lead source to match ("facebook", "website", …), case-insensitive. */
  source?: string;
  productId?: string;
  /** A user id, or "round_robin" to rotate over the eligible members. */
  assignTo: string;
};

export type LeadRoutingConfig = {
  enabled: boolean;
  /** What happens when no rule matches: rotate, or always the first eligible member. */
  mode: "round_robin" | "fixed";
  /** The eligible reps, in rotation order. */
  members: string[];
  rules: LeadRoutingRule[];
};

export const DEFAULT_LEAD_ROUTING: LeadRoutingConfig = { enabled: false, mode: "round_robin", members: [], rules: [] };

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Accepts the stored JSON string or an already-parsed object (a form post) and
 * returns a config with every field the right shape. Anything unreadable is
 * routing OFF — today's behaviour — never a half-read config that assigns.
 */
export function parseLeadRoutingConfig(raw: unknown): LeadRoutingConfig {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return DEFAULT_LEAD_ROUTING;
    }
  }
  if (!value || typeof value !== "object") return DEFAULT_LEAD_ROUTING;
  const v = value as Record<string, unknown>;
  const members = Array.isArray(v.members)
    ? [...new Set(v.members.map(text).filter((id): id is string => Boolean(id)))]
    : [];
  const rules = Array.isArray(v.rules)
    ? v.rules.flatMap((rule): LeadRoutingRule[] => {
        if (!rule || typeof rule !== "object") return [];
        const r = rule as Record<string, unknown>;
        const assignTo = text(r.assignTo);
        if (!assignTo) return [];
        const source = text(r.source)?.toLowerCase();
        const productId = text(r.productId);
        return [{ ...(source ? { source } : {}), ...(productId ? { productId } : {}), assignTo }];
      })
    : [];
  return {
    enabled: v.enabled === true,
    mode: v.mode === "fixed" ? "fixed" : "round_robin",
    members,
    rules,
  };
}

/** Every user id the config can assign to — what the caller must check eligibility for. */
export function routingCandidateIds(config: LeadRoutingConfig): string[] {
  return [...new Set([...config.members, ...config.rules.map((r) => r.assignTo).filter((a) => a !== ROUND_ROBIN)])];
}

/**
 * The next eligible member after `last`, in member order, wrapping.
 *
 * Keyed on the last USER rather than an index so editing the list (adding,
 * removing, reordering reps) never makes the pointer land on the wrong person or
 * skip the one after it. A last rep who has since been removed restarts at the top.
 */
function nextInRotation(members: string[], eligible: ReadonlySet<string>, last: string | null): string | null {
  const start = last ? members.indexOf(last) + 1 : 0;
  for (let i = 0; i < members.length; i++) {
    const candidate = members[(start + i) % members.length];
    if (eligible.has(candidate)) return candidate;
  }
  return null;
}

export type RoutingDecision = {
  userId: string | null;
  /** True when the pick came from the rotation, so the pointer must move to it. */
  rotated: boolean;
};

export function pickLeadAssignee(
  config: LeadRoutingConfig,
  lead: { source: string; productId?: string | null },
  eligible: ReadonlySet<string>,
  last: string | null,
): RoutingDecision {
  const none = { userId: null, rotated: false };
  if (!config.enabled) return none;
  const rotate = (): RoutingDecision => {
    const userId = nextInRotation(config.members, eligible, last);
    return { userId, rotated: userId !== null };
  };
  const source = lead.source.trim().toLowerCase();
  for (const rule of config.rules) {
    if (rule.source && rule.source !== source) continue;
    if (rule.productId && rule.productId !== lead.productId) continue;
    if (rule.assignTo === ROUND_ROBIN) {
      const pick = rotate();
      if (pick.userId) return pick;
      continue;
    }
    // A rule naming somebody who has left or been disabled falls through to the
    // next rule rather than stranding the lead: the rule is stale, the lead is not.
    if (eligible.has(rule.assignTo)) return { userId: rule.assignTo, rotated: false };
  }
  if (config.mode === "fixed") {
    const userId = config.members.find((id) => eligible.has(id)) ?? null;
    return { userId, rotated: false };
  }
  return rotate();
}
