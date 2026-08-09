import crypto from "crypto";
import { withTenantWrite } from "./tenantWrite";

/**
 * Atomically claims one provider-delivered inbound message/update before it can
 * drive the chatbot or create CRM side effects.
 *
 * Meta and Telegram retry webhooks. Without a durable provider-id fence, the
 * same customer message can be recorded twice and can execute a booking, lead
 * action or bot reply twice. The unique constraint is scoped by tenant + channel
 * so provider ids from different tenants/channels can never collide.
 *
 * Providers are expected to supply a stable id. If they do not, fail open for
 * that event rather than dropping a legitimate customer message we cannot
 * identify safely.
 */
export async function claimInboundBotEvent(channel: string, providerId: string): Promise<boolean> {
  const id = providerId.trim();
  if (!id) return true;

  return withTenantWrite(async (tx, tenantId) => {
    const inserted = await tx.$executeRawUnsafe(
      `INSERT INTO "BotInboundEvent" ("id", "tenantId", "channel", "providerId", "createdAt")
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT ("tenantId", "channel", "providerId") DO NOTHING`,
      crypto.randomUUID(),
      tenantId,
      channel,
      id,
    );
    return Number(inserted) === 1;
  });
}
