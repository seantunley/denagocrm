import "server-only";
import { basePrisma } from "./db";
import { getWorkspaceSetting, putTenantCredential, putTenantCredentialBundle, resolveIntegrationBundle, type SettingsTx } from "./settings";
import { recordIntegrationFailure, recordIntegrationVerified } from "./integrationConnection";
import {
  XERO_FEE_ITEM_KEYS,
  XERO_PAYMENTS_SOURCE_KEY,
  XERO_TAX_CHOICES_KEY,
  type XeroTaxChoices,
  buildXeroContact,
  chooseXeroOrganisation,
  liveInvoiceWithReference,
  matchXeroContact,
  pickTaxType,
  readXeroInvoice,
  sellableXeroItems,
  xeroErrorMessage,
  type XeroItem,
  type XeroBillTo,
  type XeroContact,
  type XeroInvoicePayload,
  type XeroInvoiceSummary,
  type XeroTaxRate,
} from "./xeroInvoice";

/**
 * Xero over OAuth 2.0 (the standard web flow — Xero's "custom connection" is not
 * offered for South African organisations). The APP is the platform's (Vercel:
 * XERO_CLIENT_ID / XERO_CLIENT_SECRET); each workspace connects its own
 * organisation and keeps its own refresh token.
 *
 * Tokens: an access token lives ~30 minutes and is never stored. Each piece of
 * work trades the stored refresh token for a fresh pair UNDER A PER-WORKSPACE
 * LOCK (Xero rotates the refresh token on every use, so two refreshes racing on
 * the same token could leave the workspace holding a dead one), then saves the
 * new refresh token before the lock is released.
 */

/**
 * Granular scopes — apps created on or after 2 March 2026 are refused the old
 * `accounting.transactions`. Invoices (create, read, PDF), contacts (find and
 * create the customer) and settings.read (the organisation's tax rates, so each
 * line's VAT lands on the right rate). offline_access yields the refresh token.
 */
export const XERO_SCOPES = "openid profile email offline_access accounting.invoices accounting.contacts accounting.settings.read";

const IDENTITY = "https://identity.xero.com/connect/token";
const API = "https://api.xero.com";
const TIMEOUT = 20_000;

export class XeroNotConnected extends Error {}
/** The consent didn't identify exactly one organisation — never guess with somebody's books. */
export class XeroAmbiguousOrganisation extends Error {}
/** The organisation is already connected to ANOTHER workspace — one Xero organisation, one workspace. */
export class XeroOrganisationInUse extends Error {}

/** The platform's Xero app, from the hosting environment. Null when it isn't set up. */
export function xeroApp(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.XERO_CLIENT_ID?.trim();
  const clientSecret = process.env.XERO_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function requireApp() {
  const app = xeroApp();
  if (!app) throw new XeroNotConnected("The Xero app isn't set up on this CRM (XERO_CLIENT_ID / XERO_CLIENT_SECRET).");
  return app;
}

function basicAuth(app: { clientId: string; clientSecret: string }): string {
  return `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;
}

/** The auth event a token was issued for — the consent screen the owner just completed. */
function authEventId(accessToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload.authentication_event_id === "string" ? payload.authentication_event_id : null;
  } catch {
    return null;
  }
}

/**
 * Finish Connect Xero: trade the code for tokens and store the ONE organisation
 * this consent connected, for this workspace only. Refuses
 * (XeroAmbiguousOrganisation) when that can't be told for certain.
 */
export async function exchangeXeroCode(input: {
  tenantId: string;
  code: string;
  redirectUri: string;
}): Promise<{ orgName: string; forgotten: { invoices: number; customers: number; products: number; payments: number } | null }> {
  const app = requireApp();
  const response = await fetch(IDENTITY, {
    method: "POST",
    headers: { Authorization: basicAuth(app), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const tokens = await response.json().catch(() => null);
  if (!response.ok || !tokens?.access_token || !tokens?.refresh_token) {
    throw new Error("Xero sign-in could not be completed. Check the app's client ID, secret and redirect URI.");
  }

  const connections = await fetch(`${API}/connections`, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const list = await connections.json().catch(() => []);
  const org = connections.ok && Array.isArray(list) ? chooseXeroOrganisation(list, authEventId(tokens.access_token)) : null;
  if (!org) throw new XeroAmbiguousOrganisation("Xero didn't say which single organisation was connected.");

  // ONE transaction: the old organisation's links are cleared and the new
  // connection saved together, or neither (review of #1067). Under the token lock,
  // so a refresh can't save the old organisation's rotated token over this one. A
  // send still running against the old organisation finds its claim cleared and
  // records nothing (sendQuoteToXero writes only while its claim stands).
  const forgotten = await basePrisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`xero-token:${input.tenantId}`}))`;
      // One Xero organisation, one workspace (Sean, 2026-11-11: "Two workspaces will
      // never share the same Xero") — enforced, not assumed: it's what lets the
      // Reference be just "INV-000123 / Q-1029". Locked on the ORGANISATION, so two
      // workspaces connecting it at the same moment can't both succeed.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`xero-org:${org.tenantId}`}))`;
      if (await xeroOrganisationTakenElsewhere(tx, input.tenantId, org.tenantId)) {
        throw new XeroOrganisationInUse(`${org.tenantName} is already connected to another workspace.`);
      }
      const previous = (await resolveIntegrationBundle(input.tenantId, "xero"))?.XERO_TENANT_ID;
      const cleared = previous && previous !== org.tenantId ? await forgetXeroLinks(tx, input.tenantId) : null;
      await putTenantCredentialBundle(
        input.tenantId,
        { XERO_TENANT_ID: org.tenantId, XERO_ORG_NAME: org.tenantName, XERO_REFRESH_TOKEN: String(tokens.refresh_token) },
        tx,
      );
      return cleared;
    },
    { timeout: 45_000, maxWait: 45_000 },
  );
  await recordIntegrationVerified(input.tenantId, "xero");
  return { orgName: org.tenantName, forgotten };
}

/**
 * Is this Xero organisation already connected to ANOTHER workspace? Checked in
 * EVERY place a workspace's connection can live: its own credential rows, and the
 * workspace settings store — which is where the founding workspace's older,
 * platform-level values are, and what resolveIntegrationBundle falls back to for
 * it (review of #1069). Call under the organisation's advisory lock.
 */
/**
 * Do payments come from Xero in this workspace? Yes once Xero is connected (Sean,
 * 2026-11-11: payments are recorded in Xero and pushed back) — unless the owner has
 * switched them back to the CRM in Settings → Integrations → Xero. Per NAMED
 * workspace, never the general settings.
 */
export async function paymentsComeFromXero(tenantId: string): Promise<boolean> {
  if (!(await resolveIntegrationBundle(tenantId, "xero"))?.XERO_TENANT_ID) return false;
  return (await getWorkspaceSetting(tenantId, XERO_PAYMENTS_SOURCE_KEY)) !== "crm";
}

export async function xeroOrganisationTakenElsewhere(tx: SettingsTx, tenantId: string, xeroOrgId: string): Promise<boolean> {
  // Deliberately across workspaces (every one but this): that IS the question.
  if ((await tx.tenantIntegrationCredential.count({ where: { tenantId: { not: tenantId }, key: "XERO_TENANT_ID", value: xeroOrgId } })) > 0) return true;
  return (await tx.appSetting.count({ where: { tenantId: { not: tenantId }, key: "XERO_TENANT_ID", value: xeroOrgId } })) > 0;
}

/**
 * Xero's IDs belong to ONE organisation. Connecting a different one — the demo
 * company first, then the real books (Sean, 2026-11-11) — forgets every link to
 * the old: the quotes' Xero invoices, customers' and fleets' Xero contacts, the
 * products' and fees' Xero items. Otherwise a test invoice would stay "already in
 * Xero" and locked, pointing at an organisation the CRM can no longer reach.
 * Xero PDFs already filed on customers are documents and stay where they are.
 *
 * Payments brought back FROM the old organisation go too (payments come from Xero,
 * 2026-11-11): its payment copies are voided — kept, marked, no longer counted — and
 * a deposit that came from it is cleared, so a demo company's money never sits on
 * a real invoice. The new organisation's Refresh brings its own.
 */
async function forgetXeroLinks(tx: SettingsTx, tenantId: string): Promise<{ invoices: number; customers: number; products: number; payments: number }> {
  const payments = await tx.quotePayment.updateMany({
    where: { tenantId, xeroPaymentId: { not: null }, voidedAt: null },
    data: { voidedAt: new Date(), voidedByName: "Xero", voidReason: "Brought back from the previous Xero organisation" },
  });
  const deposits = await tx.quote.updateMany({
    where: { tenantId, xeroDepositPaymentId: { not: null } },
    data: { depositPaidAt: null, depositPaidCents: null, xeroDepositPaymentId: null },
  });
  const invoices = await tx.quote.updateMany({
    where: { tenantId, OR: [{ xeroInvoiceId: { not: null } }, { xeroStatus: { not: null } }] },
    data: { xeroInvoiceId: null, xeroInvoiceNumber: null, xeroStatus: null, xeroTotalCents: null, xeroSentAt: null, xeroSentByName: null, xeroAmountPaidCents: null, xeroCheckedAt: null },
  });
  const contacts = await tx.contact.updateMany({ where: { tenantId, xeroContactId: { not: null } }, data: { xeroContactId: null } });
  const fleets = await tx.fleet.updateMany({ where: { tenantId, xeroContactId: { not: null } }, data: { xeroContactId: null } });
  const products = await tx.product.updateMany({
    where: { tenantId, xeroItemId: { not: null } },
    data: { xeroItemId: null, xeroItemCode: null, xeroItemName: null },
  });
  // Fee items and the sales tax choices are the old organisation's codes too.
  await tx.appSetting.updateMany({ where: { tenantId, key: { in: [...Object.values(XERO_FEE_ITEM_KEYS), XERO_TAX_CHOICES_KEY] } }, data: { value: "" } });
  return { invoices: invoices.count, customers: contacts.count + fleets.count, products: products.count, payments: payments.count + deposits.count };
}

/**
 * A fresh access token for this workspace's organisation. The refresh runs under
 * a Postgres advisory lock keyed on the workspace, and the refresh token is read
 * AFTER taking it — so a second caller waits, then uses the token the first one
 * saved, instead of spending one that has already been rotated away.
 */
async function xeroSession(tenantId: string): Promise<{ accessToken: string; xeroTenantId: string }> {
  const app = requireApp();
  return basePrisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`xero-token:${tenantId}`}))`;
      const bundle = await resolveIntegrationBundle(tenantId, "xero");
      const refreshToken = bundle?.XERO_REFRESH_TOKEN;
      const xeroTenantId = bundle?.XERO_TENANT_ID;
      if (!refreshToken || !xeroTenantId) throw new XeroNotConnected("Connect Xero in Settings → Integrations first.");

      const response = await fetch(IDENTITY, {
        method: "POST",
        headers: { Authorization: basicAuth(app), "Content-Type": "application/x-www-form-urlencoded" },
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
        throw new XeroNotConnected(lapsed ? "Xero needs reconnecting — Settings → Integrations → Reconnect Xero." : "Xero could not be reached. Try again in a moment.");
      }
      // Saved before the lock is released (the transaction ends after this returns).
      if (tokens.refresh_token) await putTenantCredential(tenantId, "XERO_REFRESH_TOKEN", String(tokens.refresh_token));
      return { accessToken: String(tokens.access_token), xeroTenantId };
    },
    { timeout: 45_000, maxWait: 45_000 },
  );
}

/** One signed-in conversation with a workspace's Xero organisation. */
export type XeroClient = {
  /** Xero tax type per VAT % used (keys are the % as text), or the reason it can't be told. `chosen`: Settings' pick per %. */
  taxTypes(rates: number[], chosen?: XeroTaxChoices): Promise<Record<string, string>>;
  /** All of Xero's tax rates — for Settings' "Sales tax" choice. */
  listTaxRates(): Promise<XeroTaxRate[]>;
  /** The customer's Xero contact: the remembered one if still live, else matched by email/name, else created. */
  resolveContact(billTo: XeroBillTo, knownContactId: string | null): Promise<{ contactId: string; created: boolean }>;
  /** A live invoice that already carries this Reference — the durable "was it already sent?" check. */
  findInvoiceByReference(reference: string): Promise<XeroInvoiceSummary | null>;
  createInvoice(payload: XeroInvoicePayload, idempotencyKey: string): Promise<XeroInvoiceSummary>;
  getInvoice(invoiceId: string): Promise<XeroInvoiceSummary>;
  /** Xero's own PDF of the invoice. */
  getInvoicePdf(invoiceId: string): Promise<Buffer>;
  /** The items Xero sells — for the product page's "Xero item" dropdown, and to look up codes at send time. */
  listItems(): Promise<ReturnType<typeof sellableXeroItems>>;
};

export async function xeroClient(tenantId: string): Promise<XeroClient> {
  const { accessToken, xeroTenantId } = await xeroSession(tenantId);

  async function call(path: string, init: { method?: "GET" | "PUT"; body?: unknown; idempotencyKey?: string; accept?: string } = {}) {
    const response = await fetch(`${API}/api.xro/2.0${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Xero-tenant-id": xeroTenantId,
        Accept: init.accept ?? "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (response.status === 401 || response.status === 403) {
      await recordIntegrationFailure(tenantId, "xero", {
        code: response.status === 403 ? "permission_denied" : "auth_failed",
        message: "Xero refused the request — the connection may be missing access. Reconnect Xero.",
        blameStep: "connect",
      });
      throw new XeroNotConnected("Xero refused the request. Reconnect Xero in Settings → Integrations.");
    }
    return response;
  }

  async function json(path: string, init: Parameters<typeof call>[1] = {}, allow404 = false): Promise<unknown> {
    const response = await call(path, init);
    if (allow404 && response.status === 404) return null;
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Xero: ${xeroErrorMessage(body, response.status)}`);
    return body;
  }

  const searchContacts = async (term: string): Promise<XeroContact[]> => {
    if (!term.trim()) return [];
    const body = (await json(`/Contacts?searchTerm=${encodeURIComponent(term.trim())}`)) as { Contacts?: XeroContact[] } | null;
    return body?.Contacts ?? [];
  };

  const client: XeroClient = {
    async listTaxRates() {
      const body = (await json("/TaxRates")) as { TaxRates?: XeroTaxRate[] } | null;
      return body?.TaxRates ?? [];
    },

    async taxTypes(rates, chosen = {}) {
      const all = await client.listTaxRates();
      const map: Record<string, string> = {};
      for (const rate of rates) {
        const picked = pickTaxType(all, rate, chosen[String(rate)]);
        if (!picked.ok) throw new Error(`Xero: ${picked.error}`);
        map[String(rate)] = picked.taxType;
      }
      return map;
    },

    async resolveContact(billTo, knownContactId) {
      if (knownContactId) {
        const body = (await json(`/Contacts/${encodeURIComponent(knownContactId)}`, {}, true)) as { Contacts?: XeroContact[] } | null;
        const known = body?.Contacts?.[0];
        if (known?.ContactID && known.ContactStatus !== "ARCHIVED") return { contactId: known.ContactID, created: false };
      }
      const candidates = [...(await searchContacts(billTo.email)), ...(await searchContacts(billTo.name))];
      const match = matchXeroContact(candidates, billTo);
      if (match.kind === "match") return { contactId: match.contactId, created: false };
      if (match.kind === "ambiguous") {
        throw new Error(`Xero: more than one Xero contact matches this customer (${match.names.join(", ")}). Merge or rename them in Xero, then send again.`);
      }
      if (match.kind === "conflict") {
        throw new Error(
          `Xero: Xero already has a contact called "${match.name}" with a different email address. If it is this customer, put the same email on both; if not, rename one of them. Then send again.`,
        );
      }
      const created = (await json("/Contacts", { method: "PUT", body: { Contacts: [buildXeroContact(billTo)] } })) as { Contacts?: XeroContact[] } | null;
      const contactId = created?.Contacts?.[0]?.ContactID;
      if (!contactId) throw new Error("Xero: the new contact was not returned.");
      return { contactId, created: true };
    },

    async findInvoiceByReference(reference) {
      // Our references are "INV-000123 / Q-1029" — no quotes to escape in the where clause.
      const where = `Type=="ACCREC" AND Reference=="${reference.replace(/"/g, "")}"`;
      return liveInvoiceWithReference(await json(`/Invoices?where=${encodeURIComponent(where)}`), reference);
    },

    async createInvoice(payload, idempotencyKey) {
      const invoice = readXeroInvoice(await json("/Invoices", { method: "PUT", body: { Invoices: [payload] }, idempotencyKey }));
      if (!invoice) throw new Error("Xero: the invoice was not returned.");
      return invoice;
    },

    async getInvoice(invoiceId) {
      const invoice = readXeroInvoice(await json(`/Invoices/${encodeURIComponent(invoiceId)}`));
      if (!invoice) throw new Error("Xero: that invoice was not found.");
      return invoice;
    },

    async listItems() {
      const body = (await json("/Items")) as { Items?: XeroItem[] } | null;
      return sellableXeroItems(body?.Items ?? []);
    },

    async getInvoicePdf(invoiceId) {
      const response = await call(`/Invoices/${encodeURIComponent(invoiceId)}`, { accept: "application/pdf" });
      if (!response.ok) throw new Error(`Xero: the invoice PDF could not be fetched (${response.status}).`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
  await recordIntegrationVerified(tenantId, "xero");
  return client;
}
