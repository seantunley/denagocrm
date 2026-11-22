import "server-only";
import { currentTenantScope } from "./tenantScope";
import { getWorkspaceSetting, putWorkspaceSetting, resolveIntegrationBundle } from "./settings";
import { threadsToken } from "./threads";
import { renewalDue } from "./threadsRenewalRule";
import { resolveTenantActor } from "./tenantActor";
import { sendPushToAll } from "./push";

/**
 * THREADS CONNECTIONS RENEW THEMSELVES (review of #1181). A Threads token lives 60 days and was only renewed when
 * someone used it, so a quiet account simply stopped working. This runs per workspace on the automations cron: in the
 * last 7 days before expiry it renews (at most every 6 hours); if Threads won't renew it, the workspace OWNER gets one
 * push notification per expiry date to press Connect Threads again. Sends nothing to customers.
 */
export const RENEW_TRIED_KEY = "THREADS_RENEW_TRIED_AT";
export const EXPIRY_WARNED_KEY = "THREADS_EXPIRY_WARNED";

export type RenewalOutcome = "none" | "fresh" | "waiting" | "renewed" | "failed";

export async function renewThreadsToken(now = Date.now()): Promise<RenewalOutcome> {
  const owner = currentTenantScope()?.tenantId ?? null;
  if (!owner) return "none";
  const app = await resolveIntegrationBundle(owner, "threads");
  if (!app?.THREADS_ACCESS_TOKEN || !app.THREADS_USER_ID) return "none";
  const expiresAt = Date.parse(app.THREADS_TOKEN_EXPIRES_AT ?? "");
  const due = renewalDue(expiresAt, Number((await getWorkspaceSetting(owner, RENEW_TRIED_KEY)) ?? 0), now);
  if (due !== "due") return due;
  await putWorkspaceSetting(owner, RENEW_TRIED_KEY, String(now));
  await threadsToken(owner);
  const after = Date.parse((await resolveIntegrationBundle(owner, "threads"))?.THREADS_TOKEN_EXPIRES_AT ?? "");
  if (after > expiresAt) return "renewed";
  // Not renewed: the owner is told ONCE for this expiry date (a reconnect brings a new date, and a new warning if needed).
  if ((await getWorkspaceSetting(owner, EXPIRY_WARNED_KEY)) !== String(expiresAt)) {
    await putWorkspaceSetting(owner, EXPIRY_WARNED_KEY, String(expiresAt));
    const ownerUser = await resolveTenantActor({ ownerOnly: true });
    const when = expiresAt <= now ? "has stopped working" : `stops working on ${new Date(expiresAt).toLocaleDateString("en-ZA", { day: "numeric", month: "long" })}`;
    if (ownerUser) {
      await sendPushToAll(
        { title: "Threads needs reconnecting", body: `Your Threads connection couldn't renew itself and ${when}. Press Connect Threads in Settings → Integrations.`, url: "/settings/integrations" },
        "system_error",
        { tenantId: owner, userId: ownerUser.id },
      );
    }
  }
  return "failed";
}
