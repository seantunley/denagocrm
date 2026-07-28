import "server-only";

import { basePrisma } from "@/lib/db";
import { runInTenantScope } from "@/lib/tenantScope";
import { isSmtpConfigured } from "@/lib/email";
import { isWhatsAppConfigured } from "@/lib/whatsapp";
import { isSmsConfigured } from "@/lib/sms";

/**
 * Per-tenant integration health for the platform console.
 *
 * Two independent signals per integration, because they answer different
 * questions and either alone is misleading:
 *   - CONFIGURED: are the credentials present at all? Read by running the app's own
 *     `is*Configured()` checks INSIDE the tenant's scope, so each tenant is asked
 *     about its own settings rather than a global one.
 *   - FAILING: has it actually errored recently? Taken from ErrorLog scopes, so a
 *     fully-configured integration that is throwing still reads as unhealthy.
 *
 * An integration can be configured and broken, or unconfigured and quiet. Only
 * showing one of the two would hide half the failures.
 *
 * IMPORTANT CAVEAT while tenant enforcement is dormant: `getSetting` reads
 * AppSetting through the guarded client, which only scopes by tenant once
 * enforcement is ON. Until then every tenant reads the same install-wide settings,
 * so the CONFIGURED column will be identical for all tenants. The mechanism is
 * correct and becomes per-tenant automatically when enforcement lands; the console
 * says so rather than implying the values are already isolated.
 */

export type IntegrationId = "email" | "whatsapp" | "sms";

export type IntegrationStatus = {
  id: IntegrationId;
  label: string;
  configured: boolean;
  /** Errors in this integration's scopes over the last 7 days. */
  errors7d: number;
  /** Most recent failure message, if any. */
  lastError: { message: string; createdAt: Date } | null;
};

/**
 * ErrorLog `scope` values that belong to each integration. Scopes are free-form
 * strings set at the call site, so this mapping is the one place that knows which
 * belong together — matched case-insensitively by prefix so `smtp-send` counts as
 * `smtp`.
 */
const SCOPES: Record<IntegrationId, string[]> = {
  email: ["smtp", "email", "imap-sync", "imap"],
  whatsapp: ["whatsapp", "wa", "meta-webhook"],
  sms: ["sms", "twilio"],
};

const LABELS: Record<IntegrationId, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
  sms: "SMS",
};

function matchesIntegration(scope: string, id: IntegrationId): boolean {
  const needle = scope.toLowerCase();
  return SCOPES[id].some((prefix) => needle === prefix || needle.startsWith(`${prefix}-`));
}

/**
 * Integration health for ONE tenant. Config checks run inside that tenant's scope;
 * errors are filtered to rows attributed to it.
 */
export async function getTenantIntegrationHealth(
  tenantId: string,
): Promise<IntegrationStatus[]> {
  // The config probes read settings; run them in the tenant's scope so that, under
  // enforcement, each tenant is asked about its own credentials.
  const [email, whatsapp, sms] = await runInTenantScope(
    { tenantId, system: false },
    async () => {
      // Never let a misconfigured integration break the whole health view.
      const safe = async (probe: () => Promise<boolean>) => probe().catch(() => false);
      return Promise.all([
        safe(isSmtpConfigured),
        safe(isWhatsAppConfigured),
        safe(isSmsConfigured),
      ]);
    },
  );

  const since = new Date(Date.now() - 7 * 24 * 3600_000);
  const errors = await basePrisma.errorLog.findMany({
    where: { tenantId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    select: { scope: true, message: true, createdAt: true },
    // Bounded: a storm must not drag the console down.
    take: 200,
  });

  const configured: Record<IntegrationId, boolean> = { email, whatsapp, sms };

  return (Object.keys(LABELS) as IntegrationId[]).map((id) => {
    const mine = errors.filter((error) => matchesIntegration(error.scope, id));
    return {
      id,
      label: LABELS[id],
      configured: configured[id],
      errors7d: mine.length,
      lastError: mine[0]
        ? { message: mine[0].message, createdAt: mine[0].createdAt }
        : null,
    };
  });
}

/** Overall verdict for a single integration, for badge colouring and sorting. */
export function integrationVerdict(
  status: IntegrationStatus,
): "failing" | "ok" | "not_configured" {
  // Errors win over "configured": a working-looking integration that is throwing
  // is the case most worth surfacing, and the one a configured-only view hides.
  if (status.errors7d > 0) return "failing";
  return status.configured ? "ok" : "not_configured";
}
