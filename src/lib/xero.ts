import "server-only";
import { putTenantCredential, putTenantCredentialBundle, resolveIntegrationBundle } from "./settings";
import { recordIntegrationFailure, recordIntegrationVerified } from "./integrationConnection";
import { readXeroInvoice, xeroErrorMessage, type XeroInvoicePayload, type XeroInvoiceSummary } from "./xeroInvoice";

/**
 * Xero over OAuth 2.0 (the standard web flow — Xero's "custom connection" is not
 * offered for South African organisations). One Xero organisation per workspace.
 *
 * Tokens: the access token lives ~30 minutes, so it is never stored; every call
 * starts by trading the stored refresh token for a fresh pair and saving the new
 * refresh token (Xero rotates it on every use, and an unused one lapses after 60
 * days — the integration then shows "Reconnect needed").
 *
 * ponytail: two sends in the same instant each refresh; Xero keeps the previous
 * refresh token usable for a short grace period, so both succeed. Serialise the
 * refresh behind a lock if a workspace ever sends in bulk.
 */

/**
 * Apps created on or after 2 March 2026 must ask for Xero's GRANULAR scopes —
 * the old `accounting.transactions` is refused for them. Invoices + contacts is
 * all "Send to Xero" needs; offline_access is what yields a refresh token.
 */
export const XERO_SCOPES = "openid profile email offline_access accounting.invoices accounting.contacts";

const IDENTITY = "https://identity.xero.com/connect/token";
const API = "https://api.xero.com";
const TIMEOUT = 20_000;

export class XeroNotConnected extends Error {}

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

async function appCredentials(tenantId: string) {
  const bundle = await resolveIntegrationBundle(tenantId, "xero");
  const clientId = bundle?.XERO_CLIENT_ID;
  const clientSecret = bundle?.XERO_CLIENT_SECRET;
  if (!bundle || !clientId || !clientSecret) throw new XeroNotConnected("Add the Xero client ID and secret in Settings → Integrations first.");
  return { bundle, clientId, clientSecret };
}

/** The auth event a token was issued for — matches the organisation chosen on Xero's consent screen. */
function authEventId(accessToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload.authentication_event_id === "string" ? payload.authentication_event_id : null;
  } catch {
    return null;
  }
}

/**
 * Finish Connect Xero: trade the code for tokens, find the organisation the
 * owner just picked, and store it with the refresh token — this workspace's rows
 * only. Returns the organisation's name for the confirmation.
 */
export async function exchangeXeroCode(input: { tenantId: string; code: string; redirectUri: string }): Promise<string> {
  const { clientId, clientSecret } = await appCredentials(input.tenantId);
  const response = await fetch(IDENTITY, {
    method: "POST",
    headers: { Authorization: basicAuth(clientId, clientSecret), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const tokens = await response.json().catch(() => null);
  if (!response.ok || !tokens?.access_token || !tokens?.refresh_token) {
    throw new Error("Xero sign-in could not be completed. Check the client ID, secret and redirect URI.");
  }

  const connections = await fetch(`${API}/connections`, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const list = (await connections.json().catch(() => [])) as Array<{ tenantId?: string; tenantName?: string; tenantType?: string; authEventId?: string; updatedDateUtc?: string }>;
  const orgs = Array.isArray(list) ? list.filter((c) => c.tenantType === "ORGANISATION" && c.tenantId) : [];
  const event = authEventId(tokens.access_token);
  // The organisation ticked on THIS consent screen; failing that, the most recently connected one.
  const org =
    orgs.find((c) => event && c.authEventId === event) ??
    [...orgs].sort((a, b) => String(b.updatedDateUtc ?? "").localeCompare(String(a.updatedDateUtc ?? "")))[0];
  if (!connections.ok || !org?.tenantId) throw new Error("No Xero organisation was connected. Tick your organisation on Xero's screen and try again.");

  await putTenantCredentialBundle(input.tenantId, {
    XERO_TENANT_ID: org.tenantId,
    XERO_ORG_NAME: org.tenantName ?? "",
    XERO_REFRESH_TOKEN: String(tokens.refresh_token),
  });
  await recordIntegrationVerified(input.tenantId, "xero");
  return org.tenantName ?? "your Xero organisation";
}

/** A fresh access token for this workspace's Xero organisation, saving the rotated refresh token. */
async function xeroSession(tenantId: string): Promise<{ accessToken: string; xeroTenantId: string }> {
  const { bundle, clientId, clientSecret } = await appCredentials(tenantId);
  const refreshToken = bundle.XERO_REFRESH_TOKEN;
  const xeroTenantId = bundle.XERO_TENANT_ID;
  if (!refreshToken || !xeroTenantId) throw new XeroNotConnected("Connect Xero in Settings → Integrations first.");

  const response = await fetch(IDENTITY, {
    method: "POST",
    headers: { Authorization: basicAuth(clientId, clientSecret), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const tokens = await response.json().catch(() => null);
  if (!response.ok || !tokens?.access_token) {
    // invalid_grant = the sign-in lapsed or was revoked in Xero: only reconnecting fixes it.
    const lapsed = tokens?.error === "invalid_grant" || response.status === 400 || response.status === 401;
    await recordIntegrationFailure(tenantId, "xero", {
      code: lapsed ? "auth_failed" : "unreachable",
      message: lapsed ? "Xero's sign-in has expired or was disconnected in Xero." : `Xero sign-in answered ${response.status}.`,
      blameStep: "connect",
    });
    throw new XeroNotConnected(lapsed ? "Xero needs reconnecting — Settings → Integrations → Connect Xero." : "Xero could not be reached. Try again in a moment.");
  }
  if (tokens.refresh_token) await putTenantCredential(tenantId, "XERO_REFRESH_TOKEN", String(tokens.refresh_token));
  return { accessToken: String(tokens.access_token), xeroTenantId };
}

async function xeroApi(tenantId: string, path: string, init: { method: "GET" | "PUT"; body?: unknown; idempotencyKey?: string }): Promise<XeroInvoiceSummary> {
  const { accessToken, xeroTenantId } = await xeroSession(tenantId);
  const response = await fetch(`${API}/api.xro/2.0${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Xero-tenant-id": xeroTenantId,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403) {
    await recordIntegrationFailure(tenantId, "xero", {
      code: response.status === 403 ? "permission_denied" : "auth_failed",
      message: "Xero refused the request — the connection may be missing invoice access. Reconnect Xero.",
      blameStep: "connect",
    });
    throw new XeroNotConnected("Xero refused the request. Reconnect Xero in Settings → Integrations.");
  }
  if (!response.ok) throw new Error(`Xero: ${xeroErrorMessage(body, response.status)}`);
  const invoice = readXeroInvoice(body);
  if (!invoice) throw new Error("Xero did not return the invoice.");
  await recordIntegrationVerified(tenantId, "xero");
  return invoice;
}

/**
 * Create the draft invoice. The idempotency key is the quote's own id, so a
 * retried or double-clicked send is answered with the SAME invoice by Xero
 * instead of creating a second one.
 */
export function createXeroInvoice(tenantId: string, payload: XeroInvoicePayload, idempotencyKey: string): Promise<XeroInvoiceSummary> {
  return xeroApi(tenantId, "/Invoices", { method: "PUT", body: { Invoices: [payload] }, idempotencyKey });
}

/** Xero's current number, status and total for an invoice made earlier. */
export function getXeroInvoice(tenantId: string, invoiceId: string): Promise<XeroInvoiceSummary> {
  return xeroApi(tenantId, `/Invoices/${encodeURIComponent(invoiceId)}`, { method: "GET" });
}
