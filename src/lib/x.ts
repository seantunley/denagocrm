import "server-only";
import { currentTenantScope } from "./tenantScope";
import { resolveTenantCredential, putTenantCredentialBundle } from "./settings";
import { basePrisma } from "./db";

const API = "https://api.x.com/2";
const TIMEOUT = 15_000;

function tenantId(): string | null {
  return currentTenantScope()?.tenantId ?? null;
}

async function tokenForCurrentTenant(): Promise<string | null> {
  return resolveTenantCredential(tenantId(), "X_ACCESS_TOKEN");
}

async function refreshXToken(owner: string): Promise<string | null> {
  const [refreshToken, clientId, clientSecret] = await Promise.all([
    resolveTenantCredential(owner, "X_REFRESH_TOKEN"),
    resolveTenantCredential(owner, "X_CLIENT_ID"),
    resolveTenantCredential(owner, "X_CLIENT_SECRET"),
  ]);
  if (!refreshToken || !clientId || !clientSecret) return null;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) return null;
  await putTenantCredentialBundle(owner, {
    X_ACCESS_TOKEN: String(body.access_token),
    X_REFRESH_TOKEN: String(body.refresh_token ?? refreshToken),
  });
  return String(body.access_token);
}

export async function sendXDirectMessage(recipientId: string, text: string): Promise<{ok: boolean; error?: string; providerMessageId?: string}> {
  const owner = tenantId();
  let token = await tokenForCurrentTenant();
  if (!token) return { ok: false, error: "X is not connected for this workspace." };
  try {
    const send = (accessToken: string) => fetch(`${API}/dm_conversations/with/${encodeURIComponent(recipientId)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
    let response = await send(token);
    if (response.status === 401 && owner) {
      token = await refreshXToken(owner);
      if (token) response = await send(token);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, error: response.status === 401 ? "Reconnect X in Settings → Integrations." : `X send failed (${response.status}).` };
    return { ok: true, providerMessageId: body?.data?.dm_event_id ?? body?.data?.id };
  } catch {
    return { ok: false, error: "X could not be reached. Try again." };
  }
}

export async function exchangeXCode(input: { tenantId: string; code: string; verifier: string; redirectUri: string }) {
  const clientId = await resolveTenantCredential(input.tenantId, "X_CLIENT_ID");
  const clientSecret = await resolveTenantCredential(input.tenantId, "X_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Configure the X client ID and secret first.");
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: input.code, grant_type: "authorization_code", redirect_uri: input.redirectUri, code_verifier: input.verifier }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const tokens = await response.json().catch(() => null);
  if (!response.ok || !tokens?.access_token) throw new Error("X authorization could not be completed.");
  const me = await fetch(`${API}/users/me?user.fields=username,name`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(TIMEOUT),
  });
  const profile = await me.json().catch(() => null);
  if (!me.ok || !profile?.data?.id) throw new Error("The connected X account could not be identified.");
  const claimed = await basePrisma.channelIdentity.findUnique({
    where: { channel_externalId: { channel: "x", externalId: String(profile.data.id) } },
    select: { tenantId: true },
  });
  if (claimed && claimed.tenantId !== input.tenantId) {
    throw new Error("This X account is already connected to another workspace.");
  }
  await basePrisma.channelIdentity.updateMany({ where: { tenantId: input.tenantId, channel: "x", disabledAt: null }, data: { disabledAt: new Date() } });
  await basePrisma.channelIdentity.upsert({
    where: { channel_externalId: { channel: "x", externalId: String(profile.data.id) } },
    update: { label: `@${profile.data.username ?? profile.data.id}`, disabledAt: null },
    create: { tenantId: input.tenantId, channel: "x", externalId: String(profile.data.id), label: `@${profile.data.username ?? profile.data.id}` },
  });
  // Persist tokens only after endpoint ownership is proven. A failed or
  // cross-tenant claim must never leave usable credentials behind.
  await putTenantCredentialBundle(input.tenantId, {
    X_ACCESS_TOKEN: String(tokens.access_token),
    X_REFRESH_TOKEN: String(tokens.refresh_token ?? ""),
    X_ACCOUNT_ID: String(profile.data.id),
    X_USERNAME: String(profile.data.username ?? ""),
  });
  return profile.data as { id: string; username?: string };
}
