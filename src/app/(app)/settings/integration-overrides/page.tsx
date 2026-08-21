import { requireTenantOwner, getActiveTenantId } from "@/lib/auth";
import { hasTenantCredentialOverride, isSecretSettingKey, resolveIntegrationBundle } from "@/lib/settings";
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
 * Tenant-facing counterpart to the (global-admin-only) `/settings` integrations
 * section: lets THIS tenant's own owner set their own override credential for
 * one of the 7 outbound integrations, without ever picking a tenant — it's
 * always their own active tenant (getActiveTenantId). Entirely separate from
 * src/app/(app)/settings/page.tsx's global AppSetting-backed credentials,
 * which this page never reads or writes.
 */
export default async function IntegrationOverridesPage() {
  // Entirely sensitive (credential management) — gate the whole page.
  // Uses requireTenantOwner so a tenant's own provisioned owner can manage
  // their credentials without needing the global platform owner role.
  await requireTenantOwner();
  const tenantId = await getActiveTenantId();
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

  // Non-secret values to prefill a reconnect with, so an owner fixing an expired
  // token doesn't retype their hostname, port and username as well.
  //
  // SECRETS ARE FILTERED OUT HERE, and this is the only place stored credential
  // values are read on this page. isSecretSettingKey is the same predicate that
  // decides what gets encrypted at rest, so a password or access token can never
  // reach the client component — a reconnect always requires retyping the secret
  // itself. Guarded by tests/integrationConfigFlow.test.ts.
  const prefills: Record<string, Record<string, string>> = {};
  if (tenantId) {
    for (const integration of TENANT_CREDENTIAL_INTEGRATIONS) {
      const flow = getIntegrationFlow(integration.id);
      if (!flow) continue;
      const bundle = await resolveIntegrationBundle(tenantId, integration.id);
      if (!bundle) continue;
      const safe: Record<string, string> = {};
      for (const key of flowFieldKeys(flow)) {
        if (isSecretSettingKey(key)) continue;
        const value = bundle[key];
        if (value) safe[key] = value;
      }
      prefills[integration.id] = safe;
    }
  }

  return (
    <SettingsWorkspace
      current="integration-overrides"
      title="Integration overrides"
      description="Give this tenant its own outbound credentials for an integration, instead of the platform's shared one."
      groups={SETTINGS_NAV_GROUPS}
    >
      <section className="card p-5 text-sm text-muted-foreground">
        {usesPlatformFallback ? (
          <p>
            Every integration below already works using the platform&apos;s shared account.
            Setting credentials here is optional — save an override and this tenant&apos;s traffic
            for that integration switches to its own account; clear it and it reverts to the
            platform default. Saved values cannot be viewed again here, only whether an override
            is currently active.
          </p>
        ) : (
          <p>
            Each integration below requires its own credentials — this tenant does <b>not</b>{" "}
            use the platform&apos;s shared accounts. Integrations shown as{" "}
            <span className="text-red-400 font-medium">Not configured</span> are unavailable
            until you save credentials for them. Saved values cannot be viewed again here, only
            whether credentials are currently set.
          </p>
        )}
      </section>

      {!tenantId ? (
        <section className="card p-5 text-sm text-muted-foreground">
          No active tenant is resolved for your account yet, so there&apos;s nothing to override here.
          Once your account resolves to a single active tenant, its per-integration overrides will
          appear on this page.
        </section>
      ) : (
        <section className="card p-0 divide-y divide-border/50">
          {TENANT_CREDENTIAL_INTEGRATIONS.map((integration) => {
            const status = integrationOverrideStatus(integration, hasOverride);
            const connection = connections.get(integration.id) ?? null;
            const needsReauth = connection?.status === "reauth_required";
            const guided = hasIntegrationFlow(integration.id);
            return (
              <SettingsIntegrationRow
                key={integration.id}
                title={integration.label}
                action={needsReauth ? "Reconnect" : guided ? "Set up" : "Configure"}
                status={
                  // Verification beats presence: an integration whose token has
                  // expired is "active" by the old field-presence rule but is in
                  // fact broken, and saying "Active" there is exactly the silent
                  // failure this feature exists to end.
                  needsReauth ? (
                    <span className="badge bg-red-500/15 text-red-400">Reconnect needed</span>
                  ) : connection?.lastVerifiedAt ? (
                    <span className="badge bg-emerald-500/15 text-emerald-300">Connected</span>
                  ) : status === "active" ? (
                    <span className="badge bg-amber-500/15 text-amber-300">Saved, not verified</span>
                  ) : status === "incomplete" ? (
                    <span className="badge bg-amber-500/15 text-amber-300">Incomplete</span>
                  ) : usesPlatformFallback ? (
                    <span className="badge bg-muted text-muted-foreground">Platform default</span>
                  ) : (
                    <span className="badge bg-red-500/15 text-red-400">Not configured</span>
                  )
                }
              >
                <p className="text-xs text-muted-foreground mb-4">{integration.description}</p>

                {integration.id === "x" && (
                  <div className="mb-5 rounded-lg border border-border bg-background/40 p-4">
                    <p className="text-sm font-medium">Connect one X account to this workspace</p>
                    <p className="mt-1 text-xs text-muted-foreground">OAuth securely grants DM read/write plus mention and reply capture. Tokens and the account mapping are stored only for the acting tenant.</p>
                    <a href="/api/integrations/x/connect" className="btn-primary btn-sm mt-3 inline-flex">
                      {hasOverride.X_ACCOUNT_ID ? "Reconnect X" : "Connect X account"}
                    </a>
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
                              {isSet ? (
                                <span className="text-xs font-normal text-emerald-400">(override active)</span>
                              ) : (
                                <span className="text-xs font-normal text-muted-foreground">(platform default)</span>
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
                                    ? "Override active — leave blank to keep, or type a new value to replace"
                                    : field.placeholder
                                }
                              />
                            )}
                          </div>
                          <button className="btn-primary">Save</button>
                        </form>
                        {isSet && (
                          <form action={clearTenantCredentialOverride.bind(null, field.key)}>
                            <button
                              className="btn-secondary"
                              title={`Clear the ${field.label} override — this tenant reverts to the platform default`}
                            >
                              Clear
                            </button>
                          </form>
                        )}
                      </div>
                    );
                  })}
                </div>
              </SettingsIntegrationRow>
            );
          })}
        </section>
      )}
    </SettingsWorkspace>
  );
}
