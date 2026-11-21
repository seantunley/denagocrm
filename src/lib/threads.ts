import "server-only";
import { basePrisma } from "./db";
import { currentTenantScope } from "./tenantScope";
import { putTenantCredentialBundle, resolveIntegrationBundle } from "./settings";

/**
 * THREADS (Sean, 2026-11-21: "Build those into the CRM as new options for social media accounts"). Comments on the
 * workspace's Threads posts come into the inbox and are answered from it — Threads has no messaging API, so there are
 * no DMs. Each workspace brings its own Meta app with the Threads use case (no third parties): app id + secret +
 * verify token in Settings → Integrations → Threads, then Connect Threads.
 *
 * Endpoints and the way the token is passed (`access_token` in the form body / query — never logged here) follow
 * ChatbotX's working integration (graph.threads.com). Tokens are long-lived (60 days) and refreshed on use when within
 * 7 days of expiry.
 */
const BASE = "https://graph.threads.com";
const GRAPH = `${BASE}/v1.0`;
const TIMEOUT = 15_000;
export const THREADS_SCOPES = ["threads_basic", "threads_read_replies", "threads_manage_replies", "threads_content_publish"];
const REFRESH_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;
const SIXTY_DAYS_S = 60 * 24 * 60 * 60;

type ThreadsResult = { ok: boolean; error?: string; providerMessageId?: string };
type Body = Record<string, unknown> | null;

function tenantId(): string | null {
  return currentTenantScope()?.tenantId ?? null;
}

async function get(url: string, params: Record<string, string>): Promise<{ ok: boolean; status: number; body: Body }> {
  const res = await fetch(`${url}?${new URLSearchParams(params)}`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT) });
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as Body };
}

async function post(url: string, params: Record<string, string>): Promise<{ ok: boolean; status: number; body: Body }> {
  const res = await fetch(url, { method: "POST", body: new URLSearchParams(params), signal: AbortSignal.timeout(TIMEOUT) });
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as Body };
}

/** The authorize address for Connect Threads. */
export function threadsAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL("https://threads.com/oauth/authorize");
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: THREADS_SCOPES.join(","), state }).toString();
  return url.toString();
}

/**
 * Connect Threads: code → short-lived token → long-lived token → the account's id and username. The account is claimed
 * for this workspace only (refused when another workspace holds it), and only then are the tokens stored.
 */
export async function exchangeThreadsCode(input: { tenantId: string; code: string; redirectUri: string }) {
  const app = await resolveIntegrationBundle(input.tenantId, "threads");
  const clientId = app?.THREADS_APP_ID;
  const clientSecret = app?.THREADS_APP_SECRET;
  if (!clientId || !clientSecret) throw new Error("Enter your Threads app ID and secret first.");
  const short = await post(`${BASE}/oauth/access_token`, { client_id: clientId, client_secret: clientSecret, redirect_uri: input.redirectUri, code: input.code, grant_type: "authorization_code" });
  if (!short.ok || typeof short.body?.access_token !== "string") throw new Error("Threads sign-in could not be completed.");
  const long = await get(`${BASE}/access_token`, { grant_type: "th_exchange_token", client_secret: clientSecret, access_token: short.body.access_token });
  if (!long.ok || typeof long.body?.access_token !== "string") throw new Error("Threads didn't give a long-lived token.");
  const token = long.body.access_token;
  const me = await get(`${GRAPH}/me`, { fields: "id,username", access_token: token });
  if (!me.ok || typeof me.body?.id !== "string") throw new Error("The Threads account could not be identified.");
  const accountId = me.body.id;
  const username = typeof me.body.username === "string" ? me.body.username : "";
  const claimed = await basePrisma.channelIdentity.findUnique({
    where: { channel_externalId: { channel: "threads", externalId: accountId } },
    select: { tenantId: true },
  });
  if (claimed && claimed.tenantId !== input.tenantId) throw new Error("This Threads account is already connected to another workspace.");
  await basePrisma.channelIdentity.updateMany({ where: { tenantId: input.tenantId, channel: "threads", disabledAt: null }, data: { disabledAt: new Date() } });
  await basePrisma.channelIdentity.upsert({
    where: { channel_externalId: { channel: "threads", externalId: accountId } },
    update: { tenantId: input.tenantId, label: `@${username || accountId}`, disabledAt: null },
    create: { tenantId: input.tenantId, channel: "threads", externalId: accountId, label: `@${username || accountId}` },
  });
  const expiresIn = typeof long.body.expires_in === "number" ? long.body.expires_in : SIXTY_DAYS_S;
  // Only after the account is proven this workspace's: a refused claim leaves no usable token behind.
  await putTenantCredentialBundle(input.tenantId, {
    THREADS_ACCESS_TOKEN: token,
    THREADS_USER_ID: accountId,
    THREADS_USERNAME: username,
    THREADS_TOKEN_EXPIRES_AT: new Date(Date.now() + expiresIn * 1000).toISOString(),
  });
  return { id: accountId, username };
}

/** This workspace's Threads token, refreshed first when it expires within 7 days. Null: not connected. */
async function threadsToken(owner: string): Promise<{ token: string; userId: string } | null> {
  const app = await resolveIntegrationBundle(owner, "threads");
  const token = app?.THREADS_ACCESS_TOKEN;
  const userId = app?.THREADS_USER_ID;
  if (!token || !userId) return null;
  const expiresAt = Date.parse(app?.THREADS_TOKEN_EXPIRES_AT ?? "");
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() < REFRESH_WITHIN_MS) {
    const refreshed = await get(`${BASE}/refresh_access_token`, { grant_type: "th_refresh_token", access_token: token }).catch(() => null);
    if (refreshed?.ok && typeof refreshed.body?.access_token === "string") {
      const expiresIn = typeof refreshed.body.expires_in === "number" ? refreshed.body.expires_in : SIXTY_DAYS_S;
      await putTenantCredentialBundle(owner, { THREADS_ACCESS_TOKEN: refreshed.body.access_token, THREADS_TOKEN_EXPIRES_AT: new Date(Date.now() + expiresIn * 1000).toISOString() });
      return { token: refreshed.body.access_token, userId };
    }
  }
  return { token, userId };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reply publicly under a Threads comment: create a TEXT reply container, wait until Threads has processed it
 * (FINISHED, up to ~30s), then publish it. A reply is public — anyone reading the post sees it.
 */
export async function replyOnThreads(replyToId: string, text: string): Promise<ThreadsResult> {
  const owner = tenantId();
  const auth = owner ? await threadsToken(owner) : null;
  if (!auth) return { ok: false, error: NOT_CONNECTED };
  try {
    const created = await post(`${GRAPH}/${auth.userId}/threads`, { media_type: "TEXT", text: text.slice(0, 500), reply_to_id: replyToId, access_token: auth.token });
    const containerId = created.body?.id;
    if (!created.ok || typeof containerId !== "string") return { ok: false, error: threadsError(created.body, created.status) };
    for (let waited = 0; waited < 30_000; waited += 2_000) {
      const status = await get(`${GRAPH}/${containerId}`, { fields: "status,error_message", access_token: auth.token });
      const state = String(status.body?.status ?? "").toUpperCase();
      if (state === "FINISHED") break;
      if (state === "ERROR" || state === "EXPIRED") return { ok: false, error: "Threads couldn't prepare the reply. Try again." };
      await sleep(2_000);
    }
    const published = await post(`${GRAPH}/${auth.userId}/threads_publish`, { creation_id: containerId, access_token: auth.token });
    if (!published.ok || typeof published.body?.id !== "string") return { ok: false, error: threadsError(published.body, published.status) };
    return { ok: true, providerMessageId: published.body.id };
  } catch {
    return { ok: false, error: "Threads could not be reached. Try again." };
  }
}

/** Hide (or show again) a reply under one of the account's own posts. */
export async function hideOnThreads(replyId: string, hidden: boolean): Promise<ThreadsResult> {
  const owner = tenantId();
  const auth = owner ? await threadsToken(owner) : null;
  if (!auth) return { ok: false, error: NOT_CONNECTED };
  try {
    const res = await post(`${GRAPH}/${replyId}/manage_reply`, { hide: String(hidden), access_token: auth.token });
    return res.ok ? { ok: true } : { ok: false, error: threadsError(res.body, res.status) };
  } catch {
    return { ok: false, error: "Threads could not be reached. Try again." };
  }
}

const NOT_CONNECTED = "Threads is not connected for this workspace (Settings → Integrations → Threads).";

function threadsError(body: Body, status: number): string {
  const error = body?.error as { message?: string; code?: number } | undefined;
  if (status === 401 || error?.code === 190) return "Reconnect Threads in Settings → Integrations.";
  return error?.message ? `Threads refused it: ${error.message}` : `Threads refused it (${status}).`;
}
