import "server-only";
import { prisma } from "./db";
import { currentScopeClass } from "./tenantWrite";
import { decryptValue, encryptValue, getSetting } from "./settings";
import { resolveActingTenant } from "./tenantContext";

export type TenantEmailProviderConfig = {
  apiKey: string | null;
  from: string | null;
  unsubscribeEmail: string | null;
  webhookPublicKey: string | null;
};

function reveal(value: string | null): string | null {
  if (!value) return null;
  try {
    return decryptValue(value);
  } catch {
    return null;
  }
}

async function legacyConfig(): Promise<TenantEmailProviderConfig> {
  const [apiKey, from, unsubscribeEmail, webhookPublicKey] = await Promise.all([
    getSetting("SENDGRID_API_KEY"),
    getSetting("SENDGRID_FROM"),
    getSetting("MARKETING_UNSUBSCRIBE_EMAIL"),
    getSetting("SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY"),
  ]);
  return { apiKey, from, unsubscribeEmail, webhookPublicKey };
}

export async function getTenantEmailProviderConfig(): Promise<TenantEmailProviderConfig> {
  const scope = currentScopeClass();
  if (scope.mode === "closed") {
    return { apiKey: null, from: null, unsubscribeEmail: null, webhookPublicKey: null };
  }
  const row = scope.mode === "tenant"
    ? await prisma.tenantEmailProvider.findUnique({ where: { tenantId: scope.tenantId } })
    : await prisma.tenantEmailProvider.findFirst({ orderBy: { updatedAt: "desc" } });
  if (!row) return legacyConfig();
  return {
    apiKey: reveal(row.apiKey),
    from: row.fromAddress,
    unsubscribeEmail: row.unsubscribeEmail,
    webhookPublicKey: reveal(row.webhookPublicKey),
  };
}

export async function saveTenantEmailProviderConfig(input: {
  userId: string;
  apiKey?: string;
  from: string;
  unsubscribeEmail: string;
  webhookPublicKey?: string;
}) {
  const tenant = await resolveActingTenant(input.userId);
  if ("error" in tenant) throw new Error("A single active organisation is required.");
  const existing = await prisma.tenantEmailProvider.findUnique({
    where: { tenantId: tenant.tenantId },
  });
  await prisma.tenantEmailProvider.upsert({
    where: { tenantId: tenant.tenantId },
    create: {
      tenantId: tenant.tenantId,
      apiKey: input.apiKey ? encryptValue(input.apiKey) : null,
      fromAddress: input.from || null,
      unsubscribeEmail: input.unsubscribeEmail || null,
      webhookPublicKey: input.webhookPublicKey ? encryptValue(input.webhookPublicKey) : null,
    },
    update: {
      apiKey: input.apiKey ? encryptValue(input.apiKey) : existing?.apiKey,
      fromAddress: input.from || null,
      unsubscribeEmail: input.unsubscribeEmail || null,
      webhookPublicKey: input.webhookPublicKey
        ? encryptValue(input.webhookPublicKey)
        : existing?.webhookPublicKey,
    },
  });
}

export async function clearTenantEmailProviderSecret(
  userId: string,
  key: "SENDGRID_API_KEY" | "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY",
) {
  const tenant = await resolveActingTenant(userId);
  if ("error" in tenant) throw new Error("A single active organisation is required.");
  await prisma.tenantEmailProvider.updateMany({
    where: { tenantId: tenant.tenantId },
    data: key === "SENDGRID_API_KEY" ? { apiKey: null } : { webhookPublicKey: null },
  });
}
