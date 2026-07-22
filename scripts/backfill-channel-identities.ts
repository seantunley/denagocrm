/**
 * Enforcement-prep backfill for Phase C 2b-C3 (ChannelIdentity). Maps OUR current
 * inbound endpoints → the home tenant so that, once enforcement is on, inbound
 * WhatsApp / Messenger / Instagram events resolve to a tenant instead of being
 * skipped (fail closed). DORMANT-safe: nothing reads ChannelIdentity until
 * enforcement, so running this early changes no behaviour.
 *
 * NOT run on deploy — Sean runs it manually before flipping enforcement, after
 * confirming the ids.
 *
 *   - WhatsApp: auto-read from the stored WA_PHONE_NUMBER_ID setting.
 *   - Messenger / Instagram: their Page id / IG account id are NOT stored anywhere
 *     (the app authenticates with a page-scoped token), so pass them explicitly:
 *       MESSENGER_PAGE_ID=... INSTAGRAM_ACCOUNT_ID=... tsx scripts/backfill-channel-identities.ts
 *     Find them in Meta Business settings, or via Graph `/me?fields=id,instagram_business_account`.
 *
 * SAFETY — `ChannelIdentity` is an AUTHORIZATION boundary (it decides which tenant
 * owns an inbound event), so this backfill NEVER silently reassigns ownership:
 *   - endpoint already mapped to a DIFFERENT tenant → FAIL LOUDLY (abort), never
 *     overwrite;
 *   - already mapped to the SAME tenant → re-enable (clear disabledAt) + refresh the
 *     label (idempotent, no ownership change);
 *   - unmapped → insert.
 * The home tenant must be chosen EXPLICITLY when the choice is ambiguous: pass
 * HOME_TENANT_ID, or rely on auto-resolution ONLY when exactly one active tenant
 * exists.
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { basePrisma } from "../src/lib/db";
import { getSetting } from "../src/lib/settings";
import type { ChannelKind } from "../src/lib/channelTenant";

/** Resolve the home tenant: explicit HOME_TENANT_ID, else the SOLE active tenant. */
export async function resolveHomeTenant(): Promise<string> {
  const explicit = process.env.HOME_TENANT_ID;
  if (explicit) {
    const [row] = await basePrisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Tenant" WHERE "id" = ${explicit} AND "active" = true LIMIT 1`;
    if (!row) throw new Error(`HOME_TENANT_ID "${explicit}" not found or not active.`);
    return row.id;
  }
  const active = await basePrisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Tenant" WHERE "active" = true ORDER BY "createdAt" ASC`;
  if (active.length === 0) throw new Error("No active tenant found — set HOME_TENANT_ID.");
  if (active.length > 1) {
    throw new Error(
      `Multiple active tenants (${active.length}) — refusing to guess. Set HOME_TENANT_ID to the owning tenant.`,
    );
  }
  return active[0].id;
}

/**
 * Map one endpoint → homeTenantId. Refuses to reassign an endpoint already owned by
 * a different tenant. Returns a status for logging.
 */
export async function upsertChannel(
  channel: ChannelKind,
  externalId: string | null,
  label: string,
  homeTenantId: string,
): Promise<"skipped-empty" | "inserted" | "reenabled" | "unchanged"> {
  if (!externalId) return "skipped-empty";
  const [existing] = await basePrisma.$queryRaw<{ tenantId: string; disabledAt: Date | null }[]>`
    SELECT "tenantId", "disabledAt" FROM "ChannelIdentity"
    WHERE "channel" = ${channel} AND "externalId" = ${externalId} LIMIT 1`;
  if (existing) {
    if (existing.tenantId !== homeTenantId) {
      throw new Error(
        `Endpoint ${channel}/${externalId} is already mapped to tenant "${existing.tenantId}" — ` +
          `refusing to reassign it to "${homeTenantId}". Resolve the ownership conflict manually.`,
      );
    }
    // Same tenant: idempotent re-enable + label refresh (no ownership change).
    await basePrisma.$executeRaw`
      UPDATE "ChannelIdentity" SET "disabledAt" = NULL, "label" = ${label}
      WHERE "channel" = ${channel} AND "externalId" = ${externalId}`;
    return existing.disabledAt ? "reenabled" : "unchanged";
  }
  await basePrisma.$executeRaw`
    INSERT INTO "ChannelIdentity" ("id", "tenantId", "channel", "externalId", "label", "createdAt")
    VALUES (${randomUUID()}, ${homeTenantId}, ${channel}, ${externalId}, ${label}, CURRENT_TIMESTAMP)`;
  return "inserted";
}

async function main() {
  const homeTenantId = await resolveHomeTenant();

  const waPhoneNumberId = await getSetting("WA_PHONE_NUMBER_ID");
  const messengerPageId = process.env.MESSENGER_PAGE_ID ?? null;
  const instagramAccountId = process.env.INSTAGRAM_ACCOUNT_ID ?? null;

  const targets: { channel: ChannelKind; externalId: string | null; label: string; hint: string }[] = [
    { channel: "whatsapp", externalId: waPhoneNumberId, label: "WhatsApp business number (backfill)", hint: "WA_PHONE_NUMBER_ID not set" },
    { channel: "messenger", externalId: messengerPageId, label: "Facebook Page (backfill)", hint: "pass MESSENGER_PAGE_ID=…" },
    { channel: "instagram", externalId: instagramAccountId, label: "Instagram account (backfill)", hint: "pass INSTAGRAM_ACCOUNT_ID=…" },
  ];

  console.log(`ChannelIdentity backfill → tenant ${homeTenantId}`);
  for (const t of targets) {
    const status = await upsertChannel(t.channel, t.externalId, t.label, homeTenantId);
    if (status === "skipped-empty") console.log(`  – skipped ${t.channel} (${t.hint})`);
    else console.log(`  ✓ ${t.channel} → ${t.externalId} (${status})`);
  }
  await basePrisma.$disconnect();
}

// Only run when executed directly — importing this module (e.g. from the guard test,
// to exercise upsertChannel's cross-tenant refusal) must have no side effects.
const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (invokedDirectly) {
  main().catch(async (e) => {
    console.error(`✗ ${e instanceof Error ? e.message : e}`);
    await basePrisma.$disconnect();
    process.exit(1);
  });
}
