/**
 * Enforcement-prep backfill for Phase C 2b-C3 (ChannelIdentity). Maps OUR current
 * inbound endpoints → the home tenant so that, once enforcement is on, inbound
 * WhatsApp / Messenger / Instagram events resolve to a tenant instead of being
 * skipped (fail closed). DORMANT-safe: nothing reads ChannelIdentity until
 * enforcement, so running this early changes no behaviour.
 *
 * NOT run on deploy — Sean runs it manually before flipping enforcement, after
 * confirming the ids. Idempotent (ON CONFLICT (channel, externalId)).
 *
 *   - WhatsApp: auto-read from the stored WA_PHONE_NUMBER_ID setting.
 *   - Messenger / Instagram: their Page id / IG account id are NOT stored anywhere
 *     (the app authenticates with a page-scoped token), so pass them explicitly:
 *       MESSENGER_PAGE_ID=... INSTAGRAM_ACCOUNT_ID=... tsx scripts/backfill-channel-identities.ts
 *     Find them in Meta Business settings, or via Graph `/me?fields=id,instagram_business_account`.
 *
 * Home tenant defaults to `tenant_denago_cpt`; override with HOME_TENANT_ID.
 */
import { randomUUID } from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { getSetting } from "../src/lib/settings";
import type { ChannelKind } from "../src/lib/channelTenant";

const HOME_TENANT_ID = process.env.HOME_TENANT_ID ?? "tenant_denago_cpt";

async function upsertChannel(channel: ChannelKind, externalId: string | null, label: string): Promise<boolean> {
  if (!externalId) return false;
  await basePrisma.$executeRaw`
    INSERT INTO "ChannelIdentity" ("id", "tenantId", "channel", "externalId", "label", "createdAt")
    VALUES (${randomUUID()}, ${HOME_TENANT_ID}, ${channel}, ${externalId}, ${label}, CURRENT_TIMESTAMP)
    ON CONFLICT ("channel", "externalId")
    DO UPDATE SET "tenantId" = EXCLUDED."tenantId", "disabledAt" = NULL`;
  return true;
}

async function main() {
  const [tenant] = await basePrisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Tenant" WHERE "id" = ${HOME_TENANT_ID} AND "active" = true LIMIT 1`;
  if (!tenant) {
    console.error(`✗ Home tenant "${HOME_TENANT_ID}" not found or not active — set HOME_TENANT_ID and retry.`);
    process.exit(1);
  }

  const waPhoneNumberId = await getSetting("WA_PHONE_NUMBER_ID");
  const messengerPageId = process.env.MESSENGER_PAGE_ID ?? null;
  const instagramAccountId = process.env.INSTAGRAM_ACCOUNT_ID ?? null;

  const done: string[] = [];
  const skipped: string[] = [];

  if (await upsertChannel("whatsapp", waPhoneNumberId, "WhatsApp business number (backfill)")) {
    done.push(`whatsapp → ${waPhoneNumberId}`);
  } else {
    skipped.push("whatsapp (WA_PHONE_NUMBER_ID not set)");
  }

  if (await upsertChannel("messenger", messengerPageId, "Facebook Page (backfill)")) {
    done.push(`messenger → ${messengerPageId}`);
  } else {
    skipped.push("messenger (pass MESSENGER_PAGE_ID=…)");
  }

  if (await upsertChannel("instagram", instagramAccountId, "Instagram account (backfill)")) {
    done.push(`instagram → ${instagramAccountId}`);
  } else {
    skipped.push("instagram (pass INSTAGRAM_ACCOUNT_ID=…)");
  }

  console.log(`ChannelIdentity backfill → tenant ${HOME_TENANT_ID}`);
  for (const d of done) console.log(`  ✓ ${d}`);
  for (const s of skipped) console.log(`  – skipped ${s}`);
  if (skipped.length) {
    console.log(
      "\nUnmapped channels will be SKIPPED (fail closed) once enforcement is on — re-run with the ids above before flipping.",
    );
  }
  await basePrisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await basePrisma.$disconnect();
  process.exit(1);
});
