import "server-only";
import { basePrisma } from "./db";
import { hasAnyPermission, type PermissionKey, type PermissionUser } from "./permissions";
import { getUserPermissions, RBAC_UNAVAILABLE } from "./permissionQuery";
import { isModuleEnabled } from "./modules/enabled";
import { resolveTenantMemberUser } from "./tenantActor";
import { currentTenantScope } from "./tenantScope";
import { tenantEnforcing } from "./tenantEnforcement";
import { rateLimitKey, registerRateLimitAttempt, type RateLimitPolicy } from "./rateLimit";

/** Who may use the assistant at all — the same set on every way in. */
export const ASSISTANT_PERMISSIONS = [
  "leads.view_all", "leads.view_owned",
  "quotes.view_all", "quotes.view_owned",
  "activities.view", "activities.manage",
] as const satisfies readonly PermissionKey[];

/**
 * How fast one person may ask, on every way in (chat, voice, WhatsApp,
 * schedules) — one key per person, so switching channel doesn't reset it.
 * Generous for real use; it exists so a stolen session can't use the
 * assistant to sweep the CRM at machine speed, or run up the ChatGPT bill.
 */
const ASK_POLICY: RateLimitPolicy = { limit: 60, windowMs: 60 * 60 * 1000, blockMs: 30 * 60 * 1000 };

export async function assistantAskAllowed(userId: string): Promise<boolean> {
  const result = await registerRateLimitAttempt(rateLimitKey("assistant-ask", userId), ASK_POLICY);
  return result.allowed;
}

export const ASK_LIMIT_MESSAGE = "You've asked a lot in the last hour — give it a few minutes and try again.";

/**
 * The assistant acting for a person with NO browser session — a scheduled
 * request firing, a question sent from their phone. The caller has already
 * entered the workspace's tenant scope (the cron's per-tenant loop, the
 * webhook's channel scope); this re-checks, at the moment it runs, everything
 * a sign-in would: they are an active, non-disabled member of THIS workspace,
 * they still hold an assistant permission, and the Automation & AI module is
 * still on. Any of those gone → null, and nothing runs. The tools then apply
 * that person's own visibility exactly as on the page.
 */
export async function assistantUserFor(userId: string): Promise<PermissionUser | null> {
  // ONE WORKSPACE OR NOTHING. resolveTenantMemberUser checks membership only
  // inside a tenant scope; in a SYSTEM scope (an unmapped channel, a platform
  // job) it resolves any user on the platform. Acting for someone there would
  // run their question with no workspace boundary at all — refuse instead.
  const scope = currentTenantScope();
  if (scope?.system) return null;
  if (tenantEnforcing() && !scope?.tenantId) return null;
  const member = await resolveTenantMemberUser(userId);
  if (!member) return null;
  const user = await basePrisma.user.findUnique({ where: { id: member.id }, select: { id: true, name: true, email: true, role: true } });
  if (!user) return null;
  // "Couldn't read their permissions" is not "they have none": a database blip
  // throws, so the WhatsApp webhook retries and the schedule cron leaves the
  // schedule for the next tick — instead of filing a staff question as a
  // customer's, or switching someone's schedule off for good.
  if (user.role !== "owner" && (await getUserPermissions(user.id)).has(RBAC_UNAVAILABLE)) {
    throw new Error("assistant: permissions unavailable");
  }
  if (!(await hasAnyPermission(user, ...ASSISTANT_PERMISSIONS))) return null;
  if (!(await isModuleEnabled("automation"))) return null;
  return user;
}
