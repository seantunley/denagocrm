import "server-only";
import crypto from "crypto";
import { basePrisma } from "./db";
import { appBaseUrl } from "./campaigns";
import { getSetting, getWorkspaceSetting, putTenantCredentialBundle, putWorkspaceSetting } from "./settings";
import { withSystemScope } from "./tenantScopeEntry";
import { CONNECTED, metaPageCredential } from "./metaPage";
import { reconcileTenantChannels } from "./channelRegistration";
import { claimChannelEndpoint } from "./channelClaim";
import { PLATFORM_URL } from "./platformLegal";

/**
 * CONNECT FACEBOOK (Sean, 2026-11-21: "Build this and lets test it" — DenagoCRM_Meta_Commercial_App_Review_Steps.md,
 * one Page per workspace; "as long as I can whitelabel the domain").
 *
 * The CRM's own Meta app is the door; what comes through it belongs to ONE workspace. A business owner presses Connect
 * Facebook on their own domain, signs in to Meta, and picks their Page: the Page's own token, its linked Instagram
 * account and the permissions granted are stored for that workspace only (lib/metaPage.ts), the Page is subscribed to
 * the app's webhooks, and its endpoints are registered to the workspace (a Page another workspace holds is refused).
 *
 * WHITE-LABEL, SAFELY: Meta allows one redirect URI, the platform's. So the sign-in returns to the platform address
 * (/callback), which only FORWARDS the code to the domain the sign-in started on — that origin is stored server-side
 * against the one-time state, never taken from the URL. The connection is made at /finish on that domain, behind the
 * person's own session and a state cookie set there: a sign-in can't be completed in someone else's browser.
 */
const VERSION = "v21.0";
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const TIMEOUT = 15_000;
const STATE_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;
const STATE_PREFIX = "META_OAUTH:";
export const PENDING_KEY = "META_CONNECT_PENDING";

/**
 * Asked for when the app has no Login for Business configuration (META_LOGIN_CONFIG_ID): Messenger, Instagram messages
 * and comments, Page webhooks, lead ads, and public replies to Page comments (pages_manage_engagement — Sean,
 * 2026-11-21: "Public replies: Yes"). App Review grants each one separately; until then they work for testers.
 */
export const META_CONNECT_SCOPES = [
  "pages_show_list", "pages_messaging", "pages_manage_metadata", "pages_read_engagement", "pages_manage_engagement",
  "business_management", "instagram_basic", "instagram_manage_messages", "instagram_manage_comments", "leads_retrieval",
];

/** The fields a connected Page is subscribed to: DMs and their receipts, Page comments, lead ads. */
export const PAGE_SUBSCRIBED_FIELDS = ["messages", "messaging_postbacks", "message_deliveries", "message_reads", "message_echoes", "feed", "leadgen"];

export type PendingPage = { id: string; name: string; token: string; igId: string | null; igUsername: string | null };

const sha = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

/** The CRM's own Meta app (platform settings): id, secret, and the optional Login for Business configuration. */
export async function metaPlatformApp(): Promise<{ appId: string; appSecret: string; configId: string | null } | null> {
  return withSystemScope(async () => {
    const [appId, appSecret, configId] = await Promise.all([getSetting("META_APP_ID"), getSetting("META_APP_SECRET"), getSetting("META_LOGIN_CONFIG_ID")]);
    return appId && appSecret ? { appId, appSecret, configId: configId || null } : null;
  });
}

/**
 * The one redirect URI registered in the Meta app — the platform app's OWN address, Honeycomb 360's
 * (Sean, 2026-11-21: "platform address yes (do not affect Denago yet)"). Only this sign-in return moves there: the CRM's
 * base address (appBaseUrl) — Denago's links, Xero, Telegram, its webhooks — stays as it is.
 */
export function metaCallbackUrl(): string {
  return `${PLATFORM_URL}/api/integrations/meta/callback`;
}

/** Is `origin` the platform's own (either address), or one of THIS workspace's verified domains? Anything else is refused. */
export async function connectOriginAllowed(tenantId: string, origin: string): Promise<boolean> {
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  if (url.origin === new URL(appBaseUrl()).origin || url.origin === PLATFORM_URL) return true;
  if (url.protocol !== "https:") return false;
  const domain = await basePrisma.tenantDomain.findFirst({ where: { tenantId, hostname: url.hostname.toLowerCase(), verifiedAt: { not: null } }, select: { id: true } });
  return Boolean(domain);
}

/** Start: a one-time state stored for this workspace with the origin to return to, and Meta's sign-in address. */
export async function startMetaConnect(input: { tenantId: string; userId: string; origin: string }): Promise<{ state: string; url: string } | null> {
  const app = await metaPlatformApp();
  if (!app) return null;
  // "<workspace id>.<32 random bytes>": the id (not a secret) says whose record to read on the way back, so no lookup
  // ever searches every workspace; the random part is what proves it.
  const state = `${input.tenantId}.${crypto.randomBytes(32).toString("base64url")}`;
  await putWorkspaceSetting(input.tenantId, STATE_PREFIX + sha(state), JSON.stringify({ origin: input.origin, userId: input.userId, expiresAt: Date.now() + STATE_TTL_MS }));
  const url = new URL(`https://www.facebook.com/${VERSION}/dialog/oauth`);
  url.search = new URLSearchParams({
    client_id: app.appId,
    redirect_uri: metaCallbackUrl(),
    state,
    response_type: "code",
    ...(app.configId ? { config_id: app.configId } : { scope: META_CONNECT_SCOPES.join(",") }),
  }).toString();
  return { state, url: url.toString() };
}

/** The callback, on the platform address: where to forward this sign-in. Null for an unknown or expired state. */
export async function metaConnectReturnOrigin(state: string): Promise<string | null> {
  if (!state || state.length > 200) return null;
  const tenantId = state.slice(0, state.indexOf("."));
  if (!/^[a-z0-9]{8,40}$/.test(tenantId)) return null;
  const value = await withSystemScope(async () => await getWorkspaceSetting(tenantId, STATE_PREFIX + sha(state)));
  if (!value) return null;
  try {
    const saved = JSON.parse(value) as { origin?: string; expiresAt?: number };
    return saved.origin && (saved.expiresAt ?? 0) > Date.now() ? saved.origin : null;
  } catch {
    return null;
  }
}

async function graph(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`${GRAPH}/${path}?${new URLSearchParams(params)}`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT) });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) throw new Error(((body?.error as { message?: string } | undefined)?.message) ?? `Meta answered ${res.status}`);
  return body;
}

/**
 * Finish, on the workspace's own domain behind its owner's session: the state must be this workspace's and unexpired
 * (then it is spent), the code is exchanged for a long-lived token, and the Pages it may manage are kept for the pick
 * (server-side, encrypted, 15 minutes — tokens never reach the browser).
 */
export async function finishMetaConnect(input: { tenantId: string; state: string; code: string }): Promise<PendingPage[]> {
  const key = STATE_PREFIX + sha(input.state);
  const saved = await getWorkspaceSetting(input.tenantId, key);
  // CONSUMED ONCE (review of #1182): only the request whose delete removed the row may go on — a second, concurrent
  // /finish for the same state deletes nothing and stops here.
  const { count } = await basePrisma.appSetting.deleteMany({ where: { tenantId: input.tenantId, key } });
  const record = saved && count === 1 ? (JSON.parse(saved) as { userId?: string; expiresAt?: number }) : null;
  if (!record || (record.expiresAt ?? 0) <= Date.now()) throw new Error("That sign-in has expired. Press Connect Facebook again.");
  const app = await metaPlatformApp();
  if (!app) throw new Error("Connect Facebook isn't set up on this CRM yet.");
  const short = await graph("oauth/access_token", { client_id: app.appId, client_secret: app.appSecret, redirect_uri: metaCallbackUrl(), code: input.code });
  const long = await graph("oauth/access_token", { grant_type: "fb_exchange_token", client_id: app.appId, client_secret: app.appSecret, fb_exchange_token: String(short.access_token ?? "") });
  const userToken = String(long.access_token ?? "");
  if (!userToken) throw new Error("Meta didn't give a long-lived token.");
  const me = await graph("me", { fields: "id", access_token: userToken });
  const permissions = await graph("me/permissions", { access_token: userToken });
  const scopes = ((permissions.data as { permission?: string; status?: string }[] | undefined) ?? [])
    .filter((row) => row.status === "granted" && row.permission)
    .map((row) => String(row.permission));
  const accounts = await graph("me/accounts", { fields: "id,name,access_token,instagram_business_account{id,username}", limit: "100", access_token: userToken });
  const pages: PendingPage[] = ((accounts.data as Record<string, unknown>[] | undefined) ?? [])
    .filter((page) => typeof page.id === "string" && typeof page.access_token === "string")
    .map((page) => {
      const ig = page.instagram_business_account as { id?: string; username?: string } | undefined;
      return { id: String(page.id), name: String(page.name ?? page.id), token: String(page.access_token), igId: ig?.id ? String(ig.id) : null, igUsername: ig?.username ? String(ig.username) : null };
    });
  await putWorkspaceSetting(input.tenantId, PENDING_KEY, JSON.stringify({ expiresAt: Date.now() + PENDING_TTL_MS, metaUserId: String(me.id ?? ""), scopes, pages }));
  return pages;
}

/** The Pages waiting to be picked — names and ids only, never a token. */
export async function pendingMetaPages(tenantId: string): Promise<{ id: string; name: string; igUsername: string | null }[] | null> {
  const pending = await readPending(tenantId);
  return pending ? pending.pages.map((page) => ({ id: page.id, name: page.name, igUsername: page.igUsername })) : null;
}

async function readPending(tenantId: string): Promise<{ metaUserId: string; scopes: string[]; pages: PendingPage[] } | null> {
  const raw = await getWorkspaceSetting(tenantId, PENDING_KEY);
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw) as { expiresAt?: number; metaUserId?: string; scopes?: string[]; pages?: PendingPage[] };
    if ((pending.expiresAt ?? 0) <= Date.now() || !Array.isArray(pending.pages)) return null;
    return { metaUserId: pending.metaUserId ?? "", scopes: pending.scopes ?? [], pages: pending.pages };
  } catch {
    return null;
  }
}

/**
 * Connect the chosen Page to this workspace: refused when another workspace holds the Page or its Instagram account;
 * the Page subscribed to the app's webhooks (proven, not assumed); then stored and registered. Returns its name.
 */
export async function connectMetaPage(input: { tenantId: string; pageId: string }): Promise<string> {
  const pending = await readPending(input.tenantId);
  const page = pending?.pages.find((candidate) => candidate.id === input.pageId);
  if (!pending || !page) throw new Error("That choice has expired. Press Connect Facebook again.");

  // CLAIMED ATOMICALLY FIRST (review of #1182): the Page, then its Instagram account — first workspace wins, an active
  // owner elsewhere is never moved — before Meta is asked anything or any token is stored. What THIS call newly took is
  // released again if a later step fails; a row that was already ours stays ours.
  const endpoints = [
    { channel: "messenger" as const, externalId: page.id, label: page.name, refusal: "That Facebook Page is already connected to another workspace." },
    ...(page.igId ? [{ channel: "instagram" as const, externalId: page.igId, label: page.igUsername ? `@${page.igUsername}` : null, refusal: "That Page's Instagram account is already connected to another workspace." }] : []),
  ];
  const newlyClaimed: { channel: "messenger" | "instagram"; externalId: string }[] = [];
  const release = async () => {
    for (const row of newlyClaimed) {
      await basePrisma.channelIdentity.updateMany({ where: { tenantId: input.tenantId, channel: row.channel, externalId: row.externalId }, data: { disabledAt: new Date() } });
    }
  };
  for (const endpoint of endpoints) {
    const before = await basePrisma.channelIdentity.findUnique({ where: { channel_externalId: { channel: endpoint.channel, externalId: endpoint.externalId } }, select: { tenantId: true, disabledAt: true } });
    const alreadyOurs = before?.tenantId === input.tenantId && !before.disabledAt;
    if (!(await claimChannelEndpoint(input.tenantId, endpoint.channel, endpoint.externalId, endpoint.label))) {
      await release();
      throw new Error(endpoint.refusal);
    }
    if (!alreadyOurs) newlyClaimed.push(endpoint);
  }

  try {
    const subscribed = await fetch(`${GRAPH}/${page.id}/subscribed_apps`, {
      method: "POST",
      body: new URLSearchParams({ subscribed_fields: PAGE_SUBSCRIBED_FIELDS.join(","), access_token: page.token }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const result = (await subscribed.json().catch(() => null)) as { success?: boolean; error?: { message?: string } } | null;
    if (!subscribed.ok || result?.success !== true) throw new Error(`Meta didn't subscribe the Page to messages: ${result?.error?.message ?? subscribed.status}`);
  } catch (error) {
    await release();
    throw error;
  }
  await putTenantCredentialBundle(input.tenantId, {
    [CONNECTED.pageToken]: page.token,
    [CONNECTED.pageId]: page.id,
    [CONNECTED.pageName]: page.name,
    [CONNECTED.igId]: page.igId ?? "",
    [CONNECTED.igUsername]: page.igUsername ?? "",
    [CONNECTED.scopes]: pending.scopes.join(","),
    [CONNECTED.byUser]: pending.metaUserId,
    [CONNECTED.at]: new Date().toISOString(),
  });
  // Blank optional values are skipped by the bundle write: clear any left from an earlier connection.
  const blanks: string[] = [];
  if (!page.igId) blanks.push(CONNECTED.igId);
  if (!page.igUsername) blanks.push(CONNECTED.igUsername);
  if (blanks.length) await basePrisma.tenantIntegrationCredential.deleteMany({ where: { tenantId: input.tenantId, key: { in: blanks } } });
  await basePrisma.appSetting.deleteMany({ where: { tenantId: input.tenantId, key: PENDING_KEY } });
  await reconcileTenantChannels(input.tenantId, { force: true });
  // VERIFIED, not assumed: every endpoint is active and THIS workspace's. Anything else and the connection is removed,
  // so no workspace is ever left holding a usable token for a Page it doesn't own.
  for (const endpoint of endpoints) {
    const row = await basePrisma.channelIdentity.findUnique({ where: { channel_externalId: { channel: endpoint.channel, externalId: endpoint.externalId } }, select: { tenantId: true, disabledAt: true } });
    if (row?.tenantId !== input.tenantId || row.disabledAt) {
      await basePrisma.tenantIntegrationCredential.deleteMany({ where: { tenantId: input.tenantId, key: { in: Object.values(CONNECTED) } } });
      await release();
      throw new Error(endpoint.refusal);
    }
  }
  return page.name;
}

/** Disconnect: the Page unsubscribed (best effort), its connection forgotten, its endpoints released. */
export async function disconnectMetaPage(tenantId: string): Promise<string | null> {
  const credential = await metaPageCredential(tenantId);
  if (credential?.kind !== "connected") return null;
  await fetch(`${GRAPH}/${credential.pageId}/subscribed_apps?${new URLSearchParams({ access_token: credential.pageToken })}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(TIMEOUT),
  }).catch(() => null);
  await basePrisma.tenantIntegrationCredential.deleteMany({ where: { tenantId, key: { in: Object.values(CONNECTED) } } });
  await reconcileTenantChannels(tenantId, { force: true });
  return credential.pageName ?? credential.pageId;
}
