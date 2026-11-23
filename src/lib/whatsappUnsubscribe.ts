import "server-only";
import { basePrisma } from "./db";
import { putTenantCredential, resolveTenantCredential } from "./settings";
import { withMetaConnectLock } from "./metaConnect";
import { logError } from "./errorLog";
import { resolveTenantActor } from "./tenantActor";
import { sendPushToAll } from "./push";
import { WA_SIGNUP_GRAPH_VERSION } from "./whatsappSignupMessage";

/**
 * LETTING GO OF A WHATSAPP BUSINESS ACCOUNT (reviews of #1187). Meta's webhook subscription is the whole account's, and
 * only one workspace holds an account (ChannelIdentity "whatsapp_account"), so when a workspace stops using one —
 * Disconnect, a switch to another account, or a new account whose connect failed after subscribing — our app is
 * unsubscribed with THAT account's token, and the hold is released only once Meta confirms.
 *
 * Not confirmed (Meta refused, timed out): the account stays held, so no other workspace inherits — or is cut off by —
 * a live subscription, and its token is kept, encrypted, in its own record (never the live connection's fields, so a
 * new connection can't overwrite it). The automations cron retries every 6 hours; after about a day of failures the
 * owner is told; the Integrations page shows it until it's done. An account connected again is never unsubscribed:
 * its record is dropped.
 *
 * Callers hold withMetaConnectLock for the workspace; the retry takes it too.
 */
export const PENDING_UNSUBSCRIBE_KEY = "WA_PENDING_UNSUBSCRIBE";
/** The account a workspace is connected through now — the same key whatsappConnect.ts writes (WA_CONNECTED.wabaId). */
const LIVE_WABA_KEY = "WA_CONNECTED_WABA_ID";
const RETRY_EVERY_MS = 6 * 60 * 60 * 1000;
const ALERT_AFTER_TRIES = 4;

type Pending = Record<string, { token: string; since: number; tries: number; triedAt: number }>;

async function readPending(tenantId: string): Promise<Pending> {
  const raw = await resolveTenantCredential(tenantId, PENDING_UNSUBSCRIBE_KEY);
  // Throws on a damaged record rather than treating it as empty and overwriting the tokens in it.
  return raw ? (JSON.parse(raw) as Pending) : {};
}

async function writePending(tenantId: string, pending: Pending): Promise<void> {
  if (Object.keys(pending).length) await putTenantCredential(tenantId, PENDING_UNSUBSCRIBE_KEY, JSON.stringify(pending));
  else await basePrisma.tenantIntegrationCredential.deleteMany({ where: { tenantId, key: PENDING_UNSUBSCRIBE_KEY } });
}

/** True only when Meta says our app is no longer subscribed. */
async function unsubscribe(wabaId: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`https://graph.facebook.com/${WA_SIGNUP_GRAPH_VERSION}/${wabaId}/subscribed_apps`, {
      method: "DELETE",
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as { success?: unknown } | null;
    return res.ok && json?.success === true;
  } catch {
    return false;
  }
}

async function release(tenantId: string, wabaId: string): Promise<void> {
  await basePrisma.channelIdentity.updateMany({ where: { tenantId, channel: "whatsapp_account", externalId: wabaId, disabledAt: null }, data: { disabledAt: new Date() } });
}

/** Remember an account to unsubscribe BEFORE anything that could lose its token (a switch overwrites it). */
export async function queueWhatsAppUnsubscribe(tenantId: string, wabaId: string, token: string): Promise<void> {
  const pending = await readPending(tenantId);
  pending[wabaId] = { token, since: pending[wabaId]?.since ?? Date.now(), tries: pending[wabaId]?.tries ?? 0, triedAt: 0 };
  await writePending(tenantId, pending);
}

/** The account is in use again (reconnected, or a failed switch restored it): it must not be unsubscribed. */
export async function dropWhatsAppUnsubscribe(tenantId: string, wabaId: string): Promise<void> {
  const pending = await readPending(tenantId);
  if (!pending[wabaId]) return;
  delete pending[wabaId];
  await writePending(tenantId, pending);
}

/** Unsubscribe, then release; or, unconfirmed, keep it held with its token for the retry. */
export async function retireWhatsAppAccount(tenantId: string, wabaId: string, token: string | null): Promise<"released" | "pending"> {
  const pending = await readPending(tenantId);
  const useToken = token ?? pending[wabaId]?.token ?? null;
  if (useToken && (await unsubscribe(wabaId, useToken))) {
    await release(tenantId, wabaId);
    if (pending[wabaId]) {
      delete pending[wabaId];
      await writePending(tenantId, pending);
    }
    return "released";
  }
  if (useToken) {
    const now = Date.now();
    pending[wabaId] = { token: useToken, since: pending[wabaId]?.since ?? now, tries: (pending[wabaId]?.tries ?? 0) + 1, triedAt: now };
    await writePending(tenantId, pending);
  }
  await logError("whatsapp-connect", new Error("Meta did not confirm the unsubscribe"), useToken ? "A WhatsApp Business account is still subscribed; retrying every 6 hours" : "A WhatsApp Business account is still subscribed and no token is left to unsubscribe it", { tenantId }).catch(() => {});
  return "pending";
}

/** What the Integrations page shows: since when each account has been waiting. No tokens. */
export async function pendingWhatsAppUnsubscribes(tenantId: string): Promise<{ since: number; tries: number }[]> {
  const [pending, live] = await Promise.all([readPending(tenantId).catch(() => ({}) as Pending), resolveTenantCredential(tenantId, LIVE_WABA_KEY)]);
  return Object.entries(pending).filter(([wabaId]) => wabaId !== live).map(([, entry]) => ({ since: entry.since, tries: entry.tries }));
}

/** Automations cron, per workspace: retry each waiting account at most every 6 hours. Returns how many were released. */
export async function retryWhatsAppUnsubscribes(tenantId: string, now = Date.now()): Promise<number> {
  if (!(await resolveTenantCredential(tenantId, PENDING_UNSUBSCRIBE_KEY))) return 0;
  // Busy (a connect or disconnect is running here): the next tick tries again.
  return withMetaConnectLock(tenantId, async () => {
    const pending = await readPending(tenantId);
    const live = await resolveTenantCredential(tenantId, LIVE_WABA_KEY);
    let released = 0;
    for (const [wabaId, entry] of Object.entries(pending)) {
      if (wabaId === live) {
        delete pending[wabaId];
        continue;
      }
      if (now - entry.triedAt < RETRY_EVERY_MS) continue;
      if (await unsubscribe(wabaId, entry.token)) {
        await release(tenantId, wabaId);
        delete pending[wabaId];
        released++;
        continue;
      }
      entry.tries++;
      entry.triedAt = now;
      if (entry.tries === ALERT_AFTER_TRIES) {
        await logError("whatsapp-connect", new Error("Meta still has not confirmed the unsubscribe"), "A disconnected WhatsApp Business account is still subscribed after a day of retries", { tenantId }).catch(() => {});
        const owner = await resolveTenantActor({ ownerOnly: true }).catch(() => null);
        if (owner) {
          await sendPushToAll(
            { title: "WhatsApp: an old account is still linked", body: "Meta hasn't confirmed it stopped sending messages from a WhatsApp Business account you no longer use. We keep trying; you can also remove the app in Meta Business settings.", url: "/settings/integrations" },
            "system_error",
            { tenantId, userId: owner.id },
          ).catch(() => {});
        }
      }
    }
    await writePending(tenantId, pending);
    return released;
  }).catch(async (error: unknown) => {
    if (!/already being changed/.test(String((error as Error | null)?.message))) await logError("whatsapp-connect", error, "Retrying WhatsApp unsubscribes failed", { tenantId }).catch(() => {});
    return 0;
  });
}
