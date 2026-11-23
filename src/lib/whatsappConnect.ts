import "server-only";
import crypto from "crypto";
import { basePrisma } from "./db";
import { getSetting, getWorkspaceSetting, putTenantCredential, putTenantCredentialBundle, putWorkspaceSetting, resolveTenantCredential } from "./settings";
import { withSystemScope } from "./tenantScopeEntry";
import { reconcileTenantChannels } from "./channelRegistration";
import { claimChannelEndpoint } from "./channelClaim";
import { dropWhatsAppUnsubscribe, queueWhatsAppUnsubscribe, retireWhatsAppAccount } from "./whatsappUnsubscribe";
import type { ChannelKind } from "./channelTenant";
import { withMetaConnectLock } from "./metaConnect";
import { logError } from "./errorLog";
import { PLATFORM_URL } from "./platformLegal";
import { WA_SIGNUP_GRAPH_VERSION, newRegistrationPin } from "./whatsappSignupMessage";

/**
 * CONNECT WHATSAPP — Meta's Embedded Signup (v4) on the platform's Meta app, Honeycomb 360 (Sean, 2026-11-21: "Build
 * the WhatsApp PRs for the easy connect for new tenants"; customers pay Meta themselves).
 *
 * The popup runs on the platform's own address (Meta only returns data to domains listed in the app), started from the
 * workspace's own domain with a one-time state stored HASHED for this workspace, and a cookie on that domain. The
 * popup hands the one-time code back to the Settings page that opened it (whatsappSignupMessage.ts); /finish there —
 * behind the owner's session and the same-browser cookie — spends the state and connects:
 *   code → business token (server only) → the number checked to be in that WhatsApp account WITH that token →
 *   claimed for this workspace (another workspace's active number is refused) → the account subscribed to our app's
 *   webhook → its PIN saved (or reused) → the number registered with it → stored as this workspace's WhatsApp →
 *   registration re-checked.
 * Any failure after the claim puts the workspace back exactly as it was. Stored in the ordinary WhatsApp fields
 * (WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN), so sending and receiving work unchanged.
 *
 * OFF until the platform owner saves the Embedded Signup configuration id (WA_SIGNUP_CONFIG_ID) beside the app id.
 */
const GRAPH = `https://graph.facebook.com/${WA_SIGNUP_GRAPH_VERSION}`;
const TIMEOUT = 15_000;
const STATE_TTL_MS = 15 * 60 * 1000;
const STATE_PREFIX = "WA_SIGNUP:";

export const WA_CONNECTED = {
  wabaId: "WA_CONNECTED_WABA_ID",
  number: "WA_CONNECTED_NUMBER",
  name: "WA_CONNECTED_NAME",
  at: "WA_CONNECTED_AT",
} as const;
/** Everything a connection writes — what a failure restores and a disconnect removes. */
const CONNECTION_KEYS = ["WA_PHONE_NUMBER_ID", "WA_ACCESS_TOKEN", ...Object.values(WA_CONNECTED)];
/**
 * Each number's two-step PIN, { phoneNumberId: pin }, encrypted (settings.ts). NOT a connection key: saved BEFORE Meta
 * is asked to register (registering can't be undone, and a timeout may hide that it worked), kept through any failure
 * and any disconnect, and reused for the same number next time — so a retry registers with the same PIN and the
 * business can always be told it (review of #1187).
 */
const PINS_KEY = "WA_REGISTER_PINS";

async function registrationPin(tenantId: string, phoneNumberId: string): Promise<string> {
  const raw = await resolveTenantCredential(tenantId, PINS_KEY);
  let pins: Record<string, string> = {};
  try {
    pins = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    // A garbled record must not lose the others silently: refuse, and the error log says why.
    throw new Error("This workspace's saved WhatsApp PINs can't be read. Please contact support before connecting.");
  }
  if (/^\d{6}$/.test(pins[phoneNumberId] ?? "")) return pins[phoneNumberId];
  const pin = newRegistrationPin(crypto.randomInt);
  await putTenantCredential(tenantId, PINS_KEY, JSON.stringify({ ...pins, [phoneNumberId]: pin }));
  return pin;
}

/** The PIN a number was registered with through Connect WhatsApp, for the business to see (Settings). */
export async function savedRegistrationPin(tenantId: string, phoneNumberId: string): Promise<string | null> {
  const raw = await resolveTenantCredential(tenantId, PINS_KEY);
  try {
    return raw ? ((JSON.parse(raw) as Record<string, string>)[phoneNumberId] ?? null) : null;
  } catch {
    return null;
  }
}

const sha = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

/** The platform app and its Embedded Signup configuration. Null: Connect WhatsApp is off. */
export async function whatsappSignupApp(): Promise<{ appId: string; appSecret: string; configId: string } | null> {
  return withSystemScope(async () => {
    const [appId, appSecret, configId] = await Promise.all([getSetting("META_APP_ID"), getSetting("META_APP_SECRET"), getSetting("WA_SIGNUP_CONFIG_ID")]);
    return appId && appSecret && configId ? { appId, appSecret, configId } : null;
  });
}

/** Start: a one-time state for this workspace (with where to hand back to) and the popup's address. */
export async function startWhatsAppSignup(input: { tenantId: string; userId: string; origin: string }): Promise<{ state: string; popupUrl: string } | null> {
  if (!(await whatsappSignupApp())) return null;
  const state = `${input.tenantId}.${crypto.randomBytes(32).toString("base64url")}`;
  await putWorkspaceSetting(input.tenantId, STATE_PREFIX + sha(state), JSON.stringify({ origin: input.origin, userId: input.userId, expiresAt: Date.now() + STATE_TTL_MS }));
  return { state, popupUrl: `${PLATFORM_URL}/connect/whatsapp?state=${encodeURIComponent(state)}` };
}

/** For the popup (no session there): where this signup hands back to. Null for an unknown or expired state. */
export async function whatsappSignupOrigin(state: string): Promise<string | null> {
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

async function graph(method: "GET" | "POST" | "DELETE", path: string, token: string | null, body?: Record<string, string>, query?: Record<string, string>) {
  const url = `${GRAPH}/${path}${query ? `?${new URLSearchParams(query)}` : ""}`;
  const res = await fetch(url, {
    method,
    cache: "no-store",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json) throw new Error(((json?.error as { message?: string } | undefined)?.message) ?? `Meta answered ${res.status}`);
  return json;
}

/**
 * Finish (on the workspace's own domain, owner session + same-browser cookie checked by the route): connect the number.
 * Returns the number as shown to people.
 */
export function connectWhatsAppNumber(input: { tenantId: string; state: string; code: string; wabaId: string; phoneNumberId: string }): Promise<string> {
  // ONE AT A TIME PER WORKSPACE (review of #1187): two tabs connecting, or a connect and a disconnect, can't interleave
  // — each restores a snapshot on failure, and the PIN record is read-modify-write. Taken before the state is spent,
  // so a refused attempt can simply be retried.
  return withMetaConnectLock(input.tenantId, () => connectWhatsAppNumberLocked(input));
}

async function connectWhatsAppNumberLocked(input: { tenantId: string; state: string; code: string; wabaId: string; phoneNumberId: string }): Promise<string> {
  // CONSUMED ONCE: only the request whose delete removed the state may go on.
  const key = STATE_PREFIX + sha(input.state);
  const saved = await getWorkspaceSetting(input.tenantId, key);
  const { count } = await basePrisma.appSetting.deleteMany({ where: { tenantId: input.tenantId, key } });
  const record = saved && count === 1 ? (JSON.parse(saved) as { expiresAt?: number }) : null;
  if (!record || (record.expiresAt ?? 0) <= Date.now()) throw new Error("That sign-up has expired. Press Connect WhatsApp again.");
  const app = await whatsappSignupApp();
  if (!app) throw new Error("Connect WhatsApp isn't set up on this CRM yet.");

  // The one-time code (5 minutes) → this business's token. Server only; the secret never leaves here.
  const exchanged = await graph("GET", "oauth/access_token", null, undefined, { client_id: app.appId, client_secret: app.appSecret, code: input.code });
  const token = String(exchanged.access_token ?? "");
  if (!token) throw new Error("Meta didn't give an access token.");

  // NOT TRUSTED FROM THE BROWSER: the number must be one of that WhatsApp account's, as Meta tells THIS token.
  const numbers = await graph("GET", `${input.wabaId}/phone_numbers`, token, undefined, { fields: "id,display_phone_number,verified_name" });
  const phone = ((numbers.data as Record<string, unknown>[] | undefined) ?? []).find((row) => String(row.id) === input.phoneNumberId);
  if (!phone) throw new Error("That number isn't in the WhatsApp account you signed in with. Please try again.");
  const display = String(phone.display_phone_number ?? input.phoneNumberId);
  const name = String(phone.verified_name ?? "");

  // SNAPSHOT FIRST, then every claim inside the block that undoes them (review of #1187 — as #1185 did for Facebook).
  const previous = await basePrisma.tenantIntegrationCredential.findMany({ where: { tenantId: input.tenantId, key: { in: CONNECTION_KEYS } }, select: { key: true, value: true } });
  const previousWaba = await resolveTenantCredential(input.tenantId, WA_CONNECTED.wabaId);
  const previousToken = previousWaba && previousWaba !== input.wabaId ? await resolveTenantCredential(input.tenantId, "WA_ACCESS_TOKEN") : null;
  let subscribeTried = false;
  // Switching accounts: the old account's token is kept apart BEFORE the new connection overwrites it, so its
  // unsubscribe can't be lost (whatsappUnsubscribe.ts). If this connect fails the old account is live again, and the
  // retry drops it unseen.
  if (previousWaba && previousToken) await queueWhatsAppUnsubscribe(input.tenantId, previousWaba, previousToken);
  const claims: { channel: ChannelKind; externalId: string; label: string | null; refusal: string }[] = [
    // ONE WORKSPACE PER WHATSAPP BUSINESS ACCOUNT: Meta's webhook subscription is the whole account's, so one
    // workspace's disconnect would cut off another's number on the same account (review of #1187).
    { channel: "whatsapp_account", externalId: input.wabaId, label: name || null, refusal: "That WhatsApp Business account is already connected to another workspace." },
    { channel: "whatsapp", externalId: input.phoneNumberId, label: name ? `${name} ${display}` : display, refusal: "That WhatsApp number is already connected to another workspace." },
  ];
  const newlyClaimed: typeof claims = [];
  try {
    // CLAIMED atomically — the first workspace wins, an active owner elsewhere is never moved.
    for (const claim of claims) {
      const before = await basePrisma.channelIdentity.findUnique({ where: { channel_externalId: { channel: claim.channel, externalId: claim.externalId } }, select: { tenantId: true, disabledAt: true } });
      const alreadyOurs = before?.tenantId === input.tenantId && !before.disabledAt;
      if (!(await claimChannelEndpoint(input.tenantId, claim.channel, claim.externalId, claim.label))) throw new Error(claim.refusal);
      if (!alreadyOurs) newlyClaimed.push(claim);
    }
    // A NEW account: its token kept for an unsubscribe before it's subscribed, so a failure (or a crash) after this can
    // always undo it. Dropped once the connection stands.
    const newAccount = newlyClaimed.some((claim) => claim.channel === "whatsapp_account");
    if (newAccount) await queueWhatsAppUnsubscribe(input.tenantId, input.wabaId, token);
    // Set BEFORE the call: a timeout may hide that Meta did subscribe it, and unsubscribing an unsubscribed account is harmless.
    subscribeTried = newAccount;
    const subscribed = await graph("POST", `${input.wabaId}/subscribed_apps`, token);
    if (subscribed.success !== true) throw new Error("Meta didn't subscribe the WhatsApp account to messages.");
    const pin = await registrationPin(input.tenantId, input.phoneNumberId);
    const registered = await graph("POST", `${input.phoneNumberId}/register`, token, { messaging_product: "whatsapp", pin });
    if (registered.success !== true) throw new Error("Meta didn't register the number.");
    await putTenantCredentialBundle(input.tenantId, {
      WA_PHONE_NUMBER_ID: input.phoneNumberId,
      WA_ACCESS_TOKEN: token,
      [WA_CONNECTED.wabaId]: input.wabaId,
      [WA_CONNECTED.number]: display,
      [WA_CONNECTED.name]: name,
      [WA_CONNECTED.at]: new Date().toISOString(),
    });
    if (!name) await basePrisma.tenantIntegrationCredential.deleteMany({ where: { tenantId: input.tenantId, key: WA_CONNECTED.name } });
    await reconcileTenantChannels(input.tenantId, { force: true });
    const row = await basePrisma.channelIdentity.findUnique({ where: { channel_externalId: { channel: "whatsapp", externalId: input.phoneNumberId } }, select: { tenantId: true, disabledAt: true } });
    if (row?.tenantId !== input.tenantId || row.disabledAt) throw new Error("That WhatsApp number is already connected to another workspace.");
    await dropWhatsAppUnsubscribe(input.tenantId, input.wabaId);
  } catch (error) {
    // Put the workspace back exactly as it was: its previous WhatsApp (if any), the account and number released if newly taken.
    await basePrisma
      .$transaction(async (tx) => {
        await tx.tenantIntegrationCredential.deleteMany({ where: { tenantId: input.tenantId, key: { in: CONNECTION_KEYS } } });
        if (previous.length) await tx.tenantIntegrationCredential.createMany({ data: previous.map((r) => ({ tenantId: input.tenantId, key: r.key, value: r.value })) });
      })
      .catch((undo: unknown) => logError("whatsapp-connect", undo, "Connect WhatsApp failed and the previous setup could not be restored").catch(() => {}));
    // An account newly taken by THIS attempt and subscribed: unsubscribed before it's let go, or kept held for the
    // retry (review of #1187). One already held (same account, another number) is left alone — the previous
    // connection still uses it.
    for (const claim of newlyClaimed) {
      if (subscribeTried && claim.channel === "whatsapp_account") continue;
      await basePrisma.channelIdentity.updateMany({ where: { tenantId: input.tenantId, channel: claim.channel, externalId: claim.externalId }, data: { disabledAt: new Date() } }).catch(() => {});
    }
    if (subscribeTried) await retireWhatsAppAccount(input.tenantId, input.wabaId, token).catch(() => {});
    else await dropWhatsAppUnsubscribe(input.tenantId, input.wabaId).catch(() => {});
    await reconcileTenantChannels(input.tenantId, { force: true }).catch(() => {});
    throw error;
  }
  // Moved to a DIFFERENT account: the old one unsubscribed with its own token, then let go (review of #1187). The new
  // connection already stands, so Meta refusing doesn't undo it — the old account stays held and is retried.
  if (previousWaba && previousWaba !== input.wabaId) await retireWhatsAppAccount(input.tenantId, previousWaba, previousToken);
  return name ? `${name} (${display})` : display;
}

/** The number connected through Connect WhatsApp, if any (a pasted setup, like Denago's, is not "connected"). */
export async function connectedWhatsApp(tenantId: string): Promise<{ wabaId: string; number: string; name: string | null; phoneNumberId: string | null } | null> {
  const [wabaId, number, name, phoneNumberId] = await Promise.all([
    resolveTenantCredential(tenantId, WA_CONNECTED.wabaId),
    resolveTenantCredential(tenantId, WA_CONNECTED.number),
    resolveTenantCredential(tenantId, WA_CONNECTED.name),
    resolveTenantCredential(tenantId, "WA_PHONE_NUMBER_ID"),
  ]);
  return wabaId && number ? { wabaId, number, name, phoneNumberId } : null;
}

/**
 * Disconnect a number connected through Connect WhatsApp: the connection forgotten, the number released, our app
 * unsubscribed from the account (retried until Meta confirms — whatsappUnsubscribe.ts). The number itself stays
 * registered with Meta — it's the business's.
 */
export function disconnectWhatsApp(tenantId: string): Promise<string | null> {
  return withMetaConnectLock(tenantId, () => disconnectWhatsAppLocked(tenantId));
}

async function disconnectWhatsAppLocked(tenantId: string): Promise<string | null> {
  const connected = await connectedWhatsApp(tenantId);
  if (!connected) return null;
  const token = await resolveTenantCredential(tenantId, "WA_ACCESS_TOKEN");
  // Kept apart BEFORE the connection's token is deleted, so the unsubscribe can always be retried (whatsappUnsubscribe.ts).
  if (token) await queueWhatsAppUnsubscribe(tenantId, connected.wabaId, token);
  await basePrisma.tenantIntegrationCredential.deleteMany({ where: { tenantId, key: { in: CONNECTION_KEYS } } });
  await reconcileTenantChannels(tenantId, { force: true });
  await retireWhatsAppAccount(tenantId, connected.wabaId, token);
  return connected.number;
}
