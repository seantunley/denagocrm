import { requireTenantOwner, getActiveTenantId } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getRegionalSettings, getWorkspaceSetting, hasTenantCredentialOverride, isSecretSettingKey, resolveIntegrationBundle } from "@/lib/settings";
import { formatDateTime } from "@/lib/format";
import XeroItemPicker from "@/components/XeroItemPicker";
import { linkFeeToXeroItem, setXeroPaymentsSource } from "@/app/actions/xero";
import { XERO_AUTO_CHECKED_AT_KEY, XERO_AUTO_CHECK_KEY, XERO_FEE_ITEM_KEYS, XERO_PAYMENTS_SOURCE_KEY, XERO_TAX_CHOICES_KEY, parseXeroItemLink, parseXeroTaxChoices } from "@/lib/xeroInvoice";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import XeroTaxRatePicker from "@/components/XeroTaxRatePicker";
import platformIntegrationRows from "@/components/settings/WorkspaceIntegrationRows";
import IntegrationTestButton from "@/components/settings/IntegrationTestButton";
import {
  INTEGRATION_META,
  STATE_LABEL,
  STATE_TONE,
  checkedAgo,
  connectedTo,
  groupIntegrationRows,
  integrationAction,
  workspaceIntegrationState,
  workspaceValueUse,
} from "@/lib/integrationsCatalogue";
import {
  saveTenantCredentialOverride,
  clearTenantCredentialOverride,
} from "@/app/actions/tenantCredentials";
import {
  TENANT_CREDENTIAL_INTEGRATIONS,
  isBooleanTenantCredentialField,
  integrationOverrideStatus,
} from "@/lib/tenantCredentialFields";
import { SettingsWorkspace, SettingsIntegrationRow } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { tenantEnforcing } from "@/lib/tenantEnforcement";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { hasIntegrationFlow, getIntegrationFlow, flowFieldKeys } from "@/lib/integrationFlow";
import { getIntegrationConnections, type IntegrationConnectionState } from "@/lib/integrationConnection";
import { IntegrationConfigFlow } from "@/components/integration-config-flow";

export const dynamic = "force-dynamic";

/**
 * Settings → Integrations: THE one place integration credentials are edited
 * (batch 6). It replaced two screens — the platform owner's Settings tab, which
 * wrote `AppSetting`, and this page as "Integration overrides", which wrote
 * `TenantIntegrationCredential`. Both old addresses redirect here.
 *
 * For the integrations that can be per-workspace (TENANT_CREDENTIAL_INTEGRATIONS)
 * a save writes this workspace's OWN credential, never the `AppSetting` default.
 * Each field says where the value in use comes from, by the same all-or-nothing
 * rule the senders use (resolveIntegrationBundle): a workspace's own values take
 * over only once every required field is set; until then the founding workspace
 * keeps using its settings values and any other workspace has none. Existing
 * settings values are read, never moved or deleted.
 *
 * Always the viewer's own active tenant. The platform owner additionally sees
 * the owner-only rows (WorkspaceIntegrationRows) that used to fill the old tab.
 */
/** What the Xero connect round trip came back with (?xero=…), in words. */
const XERO_NOTICES: Record<string, string> = {
  connected: "Xero is connected.",
  switched:
    "Xero is connected to a different organisation, so the links to the previous one were cleared: invoices can be sent again, and products and fees need linking to this organisation's items. Xero PDFs already filed on customers were kept.",
  "missing-client": "The Xero app isn't set up on this CRM yet (XERO_CLIENT_ID and XERO_CLIENT_SECRET in the hosting settings).",
  denied: "Xero sign-in was cancelled.",
  ambiguous:
    "Xero didn't say which one organisation you chose, so nothing was connected (invoices must never go to the wrong books). Press Connect Xero again and tick only the one organisation.",
  invalid: "That Xero sign-in could not be read — please try again.",
  "in-use":
    "That Xero organisation is already connected to another workspace, so nothing was connected. A Xero organisation belongs to one workspace only.",
  failed: "Xero sign-in could not be completed. Check the redirect URI in the Xero app matches this CRM's address, then try again.",
};

export default async function IntegrationsPage({ searchParams }: { searchParams?: Promise<{ xero?: string }> }) {
  const xeroNotice = XERO_NOTICES[(await searchParams)?.xero ?? ""] ?? null;
  // Entirely sensitive (credential management) — gate the whole page.
  // Uses requireTenantOwner so a tenant's own provisioned owner can manage
  // their credentials without needing the global platform owner role (a
  // platform owner passes too: isTenantOwner).
  const user = await requireTenantOwner();
  const isPlatformOwner = user.role === "owner";
  const tenantId = await getActiveTenantId();
  // THIS workspace's Xero codes — named explicitly, never the general settings
  // (which fall back to the founding workspace when enforcement is off).
  const xeroSetting = (key: string) => (tenantId ? getWorkspaceSetting(tenantId, key) : Promise.resolve(null));
  const xeroFeeItems = {
    delivery: parseXeroItemLink(await xeroSetting(XERO_FEE_ITEM_KEYS.delivery)),
    other: parseXeroItemLink(await xeroSetting(XERO_FEE_ITEM_KEYS.other)),
  };
  const xeroTaxChoices = parseXeroTaxChoices(await xeroSetting(XERO_TAX_CHOICES_KEY));
  const paymentsFromXero = (await xeroSetting(XERO_PAYMENTS_SOURCE_KEY)) !== "crm";
  const xeroAutoCheck = (await xeroSetting(XERO_AUTO_CHECK_KEY)) !== "off";
  const xeroAutoCheckedAt = await xeroSetting(XERO_AUTO_CHECKED_AT_KEY);
  const regional = await getRegionalSettings();
  // Founding tenant falls back to platform credentials when no override is set.
  // Every other tenant gets null — they must configure their own credentials.
  const usesPlatformFallback = !tenantEnforcing() || tenantId === DEFAULT_TENANT_ID;

  const allKeys = TENANT_CREDENTIAL_INTEGRATIONS.flatMap((integration) =>
    integration.fields.map((field) => field.key)
  );
  const overrideFlags = tenantId
    ? await Promise.all(allKeys.map((key) => hasTenantCredentialOverride(tenantId, key)))
    : [];
  const hasOverride: Record<string, boolean> = Object.fromEntries(
    allKeys.map((key, index) => [key, overrideFlags[index] ?? false])
  );

  // Verification state — whether these credentials were last seen actually
  // working, as opposed to merely being present. Empty map when nothing has ever
  // been through the guided flow.
  const connections = tenantId ? await getIntegrationConnections(tenantId) : new Map<string, IntegrationConnectionState>();

  // What choosing a DIFFERENT Xero organisation on Reconnect would clear (lib/xero.ts
  // forgetXeroLinks) — said before the click, so a slip to the demo company isn't a surprise.
  const xeroLinks =
    tenantId && hasOverride.XERO_TENANT_ID
      ? {
          invoices: await prisma.quote.count({ where: { tenantId, xeroInvoiceId: { not: null } } }),
          customers:
            (await prisma.contact.count({ where: { tenantId, xeroContactId: { not: null } } })) +
            (await prisma.fleet.count({ where: { tenantId, xeroContactId: { not: null } } })),
          products: await prisma.product.count({ where: { tenantId, xeroItemId: { not: null } } }),
        }
      : null;

  // Non-secret values to prefill a reconnect with, so an owner fixing an expired
  // token doesn't retype their hostname, port and username as well.
  //
  // SECRETS ARE FILTERED OUT HERE, and this is the only place stored credential
  // values are read on this page. isSecretSettingKey is the same predicate that
  // decides what gets encrypted at rest, so a password or access token can never
  // reach the client component — a reconnect always requires retyping the secret
  // itself. Guarded by tests/integrationConfigFlow.test.ts.
  //
  // The same single read also says, per field, whether the value IN USE is set
  // (`effectiveSet`, a boolean — never the value) and, for non-secret fields
  // only, what it is (`effectiveShown`), so each field can show where its value
  // comes from. The bundle itself never leaves this loop.
  const prefills: Record<string, Record<string, string>> = {};
  const effectiveSet: Record<string, boolean> = {};
  const effectiveShown: Record<string, string> = {};
  if (tenantId) {
    for (const integration of TENANT_CREDENTIAL_INTEGRATIONS) {
      const bundle = await resolveIntegrationBundle(tenantId, integration.id);
      if (!bundle) continue;
      for (const field of integration.fields) effectiveSet[field.key] = Boolean(bundle[field.key]);
      const safe: Record<string, string> = {};
      for (const key of integration.fields.map((field) => field.key)) {
        if (isSecretSettingKey(key)) continue;
        const value = bundle[key];
        if (value) safe[key] = value;
      }
      Object.assign(effectiveShown, safe);
      const flow = getIntegrationFlow(integration.id);
      if (flow) prefills[integration.id] = Object.fromEntries(flowFieldKeys(flow).filter((key) => key in safe).map((key) => [key, safe[key]]));
    }
  }

  // Each per-workspace integration as a row (settings-screens-improvements.md):
  // its state in the ONE vocabulary (lib/integrationsCatalogue.ts), what it is
  // connected to and when it was last checked, and its settings behind it.
  const workspaceRows = !tenantId ? [] : TENANT_CREDENTIAL_INTEGRATIONS.map((integration) => {
            // The workspace's own values are in use only when every required one is
            // set ("active"), the same all-or-nothing rule resolveIntegrationBundle
            // applies for the senders. Xero is judged by its connected organisation.
            const { ownStatus, sharedInUse } = workspaceValueUse({
              integrationId: integration.id,
              overrideStatus: integrationOverrideStatus(integration, hasOverride),
              requiredKeys: integration.fields.filter((field) => field.required !== false && !field.independent).map((field) => field.key),
              hasOverride,
              effectiveSet,
            });
            const ownInUse = ownStatus === "active";
            const connection = connections.get(integration.id) ?? null;
            const needsReauth = connection?.status === "reauth_required";
            const guided = hasIntegrationFlow(integration.id);
            // Verification beats presence: an integration whose token has expired is
            // "active" by the field-presence rule but is in fact broken — Reconnect needed;
            // one typed in but never proven is "Saved, not checked", never Connected.
            const state = workspaceIntegrationState({
              needsReauth,
              verified: Boolean(connection?.lastVerifiedAt),
              ownStatus,
              sharedInUse,
            });
            const detail =
              [
                // What it's connected to — only while it IS in use; a stray value on a "Not set up" row misleads.
                state === "connected" || state === "shared" ? connectedTo(integration.id, effectiveShown) : null,
                state === "shared" ? "Using the shared setup" : null,
                state === "unverified"
                  ? guided
                    ? "Saved but never tested — open it and press Test connection"
                    : "Saved but not yet seen working — it's confirmed the first time it's used"
                  : null,
                state === "incomplete" ? "Some of this workspace's own values are missing" : null,
                connection?.lastVerifiedAt ? `last checked ${checkedAgo(connection.lastVerifiedAt)}` : null,
              ].filter(Boolean).join(" · ") || null;
            return { id: integration.id, title: integration.label, state, detail, body: (
              <>
                <p className="text-xs text-muted-foreground mb-4">{integration.description}</p>

                {/* "So nobody finds out from a customer that email stopped" — a re-test of what is saved. */}
                {guided && state !== "not-set-up" && state !== "incomplete" && <IntegrationTestButton integrationId={integration.id} />}

                {integration.id === "x" && (
                  <div className="mb-5 rounded-lg border border-border bg-background/40 p-4">
                    <p className="text-sm font-medium">Connect one X account to this workspace</p>
                    <p className="mt-1 text-xs text-muted-foreground">OAuth securely grants DM read/write plus mention and reply capture. Tokens and the account mapping are stored only for the acting tenant.</p>
                    <a href="/api/integrations/x/connect" className="btn-primary btn-sm mt-3 inline-flex">
                      {hasOverride.X_ACCOUNT_ID ? "Reconnect X" : "Connect X account"}
                    </a>
                  </div>
                )}

                {integration.id === "xero" && (
                  <div className="mb-5 rounded-lg border border-border bg-background/40 p-4">
                    <p className="text-sm font-medium">
                      {effectiveShown.XERO_ORG_NAME ? `Connected to ${effectiveShown.XERO_ORG_NAME}` : "Connect your Xero organisation"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Connecting lets the Deliveries board send an accepted quote to Xero as a <b>draft</b> invoice and keep
                      Xero&apos;s invoice number on the quote. Nothing is approved or emailed from the CRM — you finish the
                      invoice in Xero. The sales account code below is optional.
                    </p>
                    {xeroNotice && <p className="mt-2 text-xs text-amber-300">{xeroNotice}</p>}
                    {xeroLinks && (
                      <p className="mt-2 text-xs text-amber-300">
                        Reconnecting to {effectiveShown.XERO_ORG_NAME ?? "the same organisation"} keeps everything. Choosing a
                        different organisation clears this workspace&apos;s links to this one: {xeroLinks.invoices} invoice
                        {xeroLinks.invoices === 1 ? "" : "s"}, {xeroLinks.customers} customer{xeroLinks.customers === 1 ? "" : "s"},{" "}
                        {xeroLinks.products} product{xeroLinks.products === 1 ? "" : "s"}, the fee items and the sales tax choice. Filed Xero PDFs stay.
                      </p>
                    )}
                    <a href="/api/integrations/xero/connect" className="btn-primary btn-sm mt-3 inline-flex">
                      {hasOverride.XERO_TENANT_ID ? "Reconnect Xero" : "Connect Xero"}
                    </a>
                    {hasOverride.XERO_TENANT_ID && (
                      <div className="mt-5 grid gap-5 border-t border-border pt-4 sm:grid-cols-2">
                        <XeroItemPicker
                          label="Xero item for delivery fees"
                          current={xeroFeeItems.delivery}
                          action={linkFeeToXeroItem.bind(null, "delivery")}
                          hint="Delivery fee lines go to Xero under this item. Wording, amount and VAT stay the quote's."
                        />
                        <XeroItemPicker
                          label="Xero item for other fees"
                          current={xeroFeeItems.other}
                          action={linkFeeToXeroItem.bind(null, "other")}
                          hint="Any other fee on a quote. Leave unlinked to send fees without an item code."
                        />
                        <XeroTaxRatePicker current={xeroTaxChoices} />
                        {/* Payments come from Xero (2026-11-11) — visible and switchable. */}
                        <SaveForm action={setXeroPaymentsSource} resetOnSuccess={false} className="space-y-2">
                          <p className="label">Payments</p>
                          <label className="flex items-start gap-2 text-sm">
                            <input type="checkbox" name="fromXero" defaultChecked={paymentsFromXero} className="mt-1" />
                            <span>
                              Payments come from Xero
                              <span className="block text-[11px] text-muted-foreground">
                                Record deposits and payments in Xero; Refresh brings them back, so the CRM&apos;s invoices and statements match Xero.
                                Untick to record them in the CRM again — the CRM&apos;s own deposit and payment forms come back on every invoice.
                              </span>
                            </span>
                          </label>
                          {/* The daily automatic check (2026-11-11; once a day since 2026-11-13) — only relevant while payments come from Xero. */}
                          {paymentsFromXero && (
                            <label className="flex items-start gap-2 text-sm">
                              <input type="hidden" name="autoCheckShown" value="1" />
                              <input type="checkbox" name="autoCheck" defaultChecked={xeroAutoCheck} className="mt-1" />
                              <span>
                                Check Xero for payments automatically
                                <span className="block text-[11px] text-muted-foreground">
                                  Once a day, early in the morning, the CRM checks your open invoices in Xero and brings back new payments, as Refresh does. For anything sooner, press Refresh.
                                  {xeroAutoCheck && (xeroAutoCheckedAt ? ` Last checked ${formatDateTime(xeroAutoCheckedAt, regional)}.` : " Not run yet.")}
                                </span>
                              </span>
                            </label>
                          )}
                          <SaveButton className="btn-secondary btn-sm" pendingLabel="Saving…">Save</SaveButton>
                        </SaveForm>
                      </div>
                    )}
                  </div>
                )}

                {connection && (
                  <div
                    className={`mb-4 rounded-md border p-3 text-xs ${
                      needsReauth
                        ? "border-red-500/30 bg-red-500/10 text-red-300"
                        : "border-border bg-background/40 text-muted-foreground"
                    }`}
                  >
                    {needsReauth ? (
                      <>
                        <p className="font-medium">This integration has stopped working.</p>
                        {connection.lastErrorText && <p className="mt-1">{connection.lastErrorText}</p>}
                        <p className="mt-1">
                          Messages are failing until it is reconnected. The setup below opens at the step that needs
                          fixing.
                        </p>
                      </>
                    ) : (
                      <p>
                        Last verified{" "}
                        {connection.lastVerifiedAt
                          ? connection.lastVerifiedAt.toISOString().slice(0, 16).replace("T", " ") + " UTC"
                          : "never"}
                        .
                        {connection.lastErrorText && ` Most recent problem: ${connection.lastErrorText}`}
                      </p>
                    )}
                  </div>
                )}

                {guided && (
                  <div className="mb-6">
                    <IntegrationConfigFlow
                      integrationId={integration.id}
                      startAtStep={needsReauth ? connection?.blameStep : null}
                      prefill={prefills[integration.id] ?? {}}
                    />
                  </div>
                )}

                {guided && (
                  <details className="mb-3">
                    <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                      Set a single field directly, without the guided test
                    </summary>
                    <p className="mt-2 text-xs text-amber-300/80">
                      Saving a field here skips the connection test, so it will not be verified.
                    </p>
                  </details>
                )}

                <div className="space-y-3">
                  {integration.fields.map((field) => {
                    const isSet = hasOverride[field.key];
                    const secret = isSecretSettingKey(field.key);
                    const boolField = isBooleanTenantCredentialField(field.key);
                    // Where the value IN USE comes from — by the bundle rule, not by
                    // whether this one key has a saved value of its own. An
                    // `independent` field (X's sign-in tokens, Grok) counts on its
                    // own whenever the integration is available at all.
                    const ownCounts = field.independent ? isSet && effectiveSet[field.key] : ownInUse && isSet;
                    const source = ownCounts ? "own" : effectiveSet[field.key] ? "default" : "unset";
                    const savedNotInUse = isSet && !ownCounts;
                    const shown = secret ? undefined : effectiveShown[field.key];
                    return (
                      <div key={field.key} className="flex gap-2 items-end">
                        <form
                          action={saveTenantCredentialOverride}
                          className="flex flex-1 gap-2 items-end"
                        >
                          <input type="hidden" name="key" value={field.key} />
                          <div className="flex-1">
                            <label className="label">
                              {field.label}{" "}
                              {source === "own" ? (
                                <span className="text-xs font-normal text-emerald-400">(this workspace&apos;s own)</span>
                              ) : source === "default" ? (
                                <span className="text-xs font-normal text-muted-foreground">(shared setup)</span>
                              ) : (
                                <span className="text-xs font-normal text-muted-foreground">(not set)</span>
                              )}
                              {savedNotInUse && (
                                <span className="text-xs font-normal text-amber-300"> · your saved value is not in use until every required field is set</span>
                              )}
                            </label>
                            {boolField ? (
                              <select name="value" className="input" defaultValue="">
                                <option value="">— leave unchanged —</option>
                                <option value="true">On (TLS/SSL)</option>
                                <option value="false">Off</option>
                              </select>
                            ) : (
                              <input
                                name="value"
                                type={secret ? "password" : "text"}
                                autoComplete={secret ? "new-password" : "off"}
                                className="input"
                                placeholder={
                                  isSet
                                    ? "Saved — leave blank to keep, or type a new value to replace"
                                    : field.placeholder
                                }
                              />
                            )}
                            {shown && (
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                In use: <code className="rounded bg-muted px-1">{shown}</code>
                              </p>
                            )}
                          </div>
                          <button className="btn-primary">Save</button>
                        </form>
                        {isSet && (
                          <form action={clearTenantCredentialOverride.bind(null, field.key)}>
                            <button
                              className="btn-secondary"
                              title={`Clear this workspace's own ${field.label} — it goes back to the shared setup, if there is one`}
                            >
                              Clear
                            </button>
                          </form>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            ) };
          });

  // The platform owner's own rows (webhooks, Telegram, AI, voice, intake…), from
  // the old Settings → Integrations tab — owner-only, as that tab was — filed
  // under the same purposes as the workspace's own.
  const platformRows = isPlatformOwner ? await platformIntegrationRows({ xAccountId: effectiveShown.X_ACCOUNT_ID ?? null }) : [];
  const grouped = groupIntegrationRows([...workspaceRows, ...platformRows]);

  return (
    <SettingsWorkspace
      current="integrations"
      title="Integrations"
      description="Connect the channels and services this workspace uses."
      groups={SETTINGS_NAV_GROUPS}
    >
      {/* Plain intro; the detail is on demand. */}
      <details className="card p-4 text-sm text-muted-foreground">
        <summary className="cursor-pointer select-none text-foreground">How this works</summary>
        {usesPlatformFallback ? (
          <p className="mt-2">
            Saving here gives this workspace its <b>own</b> settings for that integration. They take over only once
            <b> every required field</b> is set — until then it keeps using the <b>shared setup</b>. Clear them to go back to
            it. Passwords and keys can&apos;t be viewed again once saved, only whether they are set.
          </p>
        ) : (
          <p className="mt-2">
            This workspace needs its own settings for each integration — it doesn&apos;t use a shared setup. An integration
            that is <b>Not set up</b> can&apos;t be used until you connect it. Passwords and keys can&apos;t be viewed again once
            saved, only whether they are set.
          </p>
        )}
        <p className="mt-2">
          <b>Connected</b> means it has been seen working — a test passed, a message went out, or you signed in to it.
          Settings you&apos;ve saved that haven&apos;t been proven yet show as <b>Saved, not checked</b>.
        </p>
      </details>

      {!tenantId && (
        <section className="card p-5 text-sm text-muted-foreground">
          Your account isn&apos;t linked to a workspace yet, so there&apos;s nothing to connect here.
        </section>
      )}

      {grouped.map(({ group, rows }) => (
        <section key={group.key} aria-labelledby={`integrations-${group.key}`} className="space-y-2">
          <div className="px-1">
            <h2 id={`integrations-${group.key}`} className={`text-sm font-semibold ${group.key === "attention" ? "text-amber-200" : "text-foreground"}`}>{group.label}</h2>
            <p className="text-xs text-muted-foreground">{group.description}</p>
          </div>
          <div className={`card p-0 ${group.key === "attention" ? "border-amber-500/30" : ""}`}>
            {rows.map((row) => {
              const meta = INTEGRATION_META[row.id];
              return (
                <SettingsIntegrationRow
                  key={row.id}
                  title={row.title}
                  mark={meta?.mark}
                  purpose={meta?.purpose}
                  detail={row.detail}
                  action={integrationAction(row.state)}
                  status={<span className={`badge ${STATE_TONE[row.state]}`}>{STATE_LABEL[row.state]}</span>}
                >
                  {row.body}
                </SettingsIntegrationRow>
              );
            })}
          </div>
        </section>
      ))}
    </SettingsWorkspace>
  );
}
