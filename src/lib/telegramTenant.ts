import "server-only";
import { basePrisma } from "./db";
import { decryptValue } from "./settings";
import { secretEquals } from "./secretCompare";
import { tenantEnforcing } from "./tenantEnforcement";
import { runInTenantScope } from "./tenantScope";

type TelegramSecretRow = { tenantId: string; value: string };

/**
 * Telegram updates do not contain a stable id for OUR bot endpoint, so unlike
 * Meta/WhatsApp there is no payload discriminator that can feed ChannelIdentity.
 * Telegram does, however, echo the per-webhook secret token that DenagoCRM sets
 * when that tenant connects its bot. Resolve that secret in the trusted pre-scope
 * boundary, then enter exactly the owning tenant before any guarded CRM/settings
 * read occurs.
 *
 * We deliberately scan only active tenants' TELEGRAM_WEBHOOK_SECRET rows and
 * compare decrypted values with a timing-safe helper. The secret itself is never
 * logged or returned. This preserves existing webhook URLs and needs no reconnect.
 */
export async function resolveTelegramTenant(secret: string | null | undefined): Promise<string | null> {
  if (!secret) return null;
  const rows = await basePrisma.$queryRaw<TelegramSecretRow[]>`
    SELECT s."tenantId", s."value"
      FROM "AppSetting" s
      JOIN "Tenant" t ON t."id" = s."tenantId"
     WHERE s."key" = 'TELEGRAM_WEBHOOK_SECRET'
       AND t."active" = true`;

  for (const row of rows) {
    let expected: string;
    try {
      expected = decryptValue(row.value);
    } catch {
      continue;
    }
    if (secretEquals(secret, expected)) return row.tenantId;
  }
  return null;
}

export async function withTelegramTenantScope<T>(
  secret: string | null | undefined,
  fn: () => Promise<T>,
  onUnresolved: () => T | Promise<T>,
): Promise<T> {
  // Match the rest of the tenancy rollout: when enforcement is intentionally
  // dormant, preserve the existing single-tenant path exactly.
  if (!tenantEnforcing()) return fn();
  const tenantId = await resolveTelegramTenant(secret);
  if (!tenantId) return onUnresolved();
  return runInTenantScope({ tenantId, system: false }, fn);
}
