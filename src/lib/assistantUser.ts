import "server-only";
import { basePrisma } from "./db";
import { hasAnyPermission, type PermissionKey, type PermissionUser } from "./permissions";
import { getUserPermissions, RBAC_UNAVAILABLE } from "./permissionQuery";
import { isModuleEnabled } from "./modules/enabled";
import { resolveTenantMemberUser } from "./tenantActor";
import { currentTenantScope } from "./tenantScope";
import { tenantEnforcing } from "./tenantEnforcement";
import { rateLimitKey, registerRateLimitAttempt, type RateLimitPolicy } from "./rateLimit";
import { logError } from "./errorLog";

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

/**
 * Count one use against a limit. The attempt that STARTS a block goes to the
 * System Log (who, which limit — never the question): reaching a limit is
 * either someone working very hard or a session being abused, and the owner
 * should be able to see which. Later attempts during the block aren't logged,
 * so a script hammering a blocked session can't flood the log.
 */
async function allowedUnder(key: string, kind: string, userId: string, policy: RateLimitPolicy): Promise<boolean> {
  const result = await registerRateLimitAttempt(key, policy);
  if (!result.allowed && result.retryAfterSeconds * 1000 >= policy.blockMs) {
    await logError("crm-assistant", `${kind} limit reached`, `user ${userId} — blocked ${policy.blockMs / 60_000} min`, { alert: false });
  }
  return result.allowed;
}

export async function assistantAskAllowed(userId: string): Promise<boolean> {
  return allowedUnder(rateLimitKey("assistant-ask", userId), "assistant-ask", userId, ASK_POLICY);
}

export const ASK_LIMIT_MESSAGE = "You've asked a lot in the last hour — give it a few minutes and try again.";

/**
 * Narrower limits for the costlier extras, ON TOP of the ask limit, each with
 * its own key so one question costs one ask:
 *  - voice: transcription happens before the question is asked (it used to
 *    count as an ask too, so a spoken question cost two);
 *  - images: an upload per question;
 *  - web: an internet search, counted only when one actually runs.
 */
const VOICE_POLICY: RateLimitPolicy = { limit: 60, windowMs: 60 * 60 * 1000, blockMs: 30 * 60 * 1000 };
const IMAGE_POLICY: RateLimitPolicy = { limit: 30, windowMs: 60 * 60 * 1000, blockMs: 30 * 60 * 1000 };
const WEB_POLICY: RateLimitPolicy = { limit: 20, windowMs: 60 * 60 * 1000, blockMs: 30 * 60 * 1000 };

export async function assistantVoiceAllowed(userId: string): Promise<boolean> {
  return allowedUnder(rateLimitKey("assistant-voice", userId), "assistant-voice", userId, VOICE_POLICY);
}
export async function assistantImageAllowed(userId: string): Promise<boolean> {
  return allowedUnder(rateLimitKey("assistant-image", userId), "assistant-image", userId, IMAGE_POLICY);
}
export async function assistantWebAllowed(userId: string): Promise<boolean> {
  return allowedUnder(rateLimitKey("assistant-web", userId), "assistant-web", userId, WEB_POLICY);
}

/**
 * Answers read ALOUD (a WhatsApp voice note back, the CRM's Listen button):
 * ElevenLabs bills per character, so a person gets this many an hour on top of
 * their asks. Over it they still get every answer — as text.
 */
const VOICE_REPLY_POLICY: RateLimitPolicy = { limit: 30, windowMs: 60 * 60 * 1000, blockMs: 30 * 60 * 1000 };
export async function assistantVoiceReplyAllowed(userId: string): Promise<boolean> {
  return allowedUnder(rateLimitKey("assistant-voice-reply", userId), "assistant-voice-reply", userId, VOICE_REPLY_POLICY);
}
export const VOICE_REPLY_LIMIT_MESSAGE = "You've listened to a lot of answers in the last hour — they're all still here to read.";

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
