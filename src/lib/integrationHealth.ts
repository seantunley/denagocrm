import "server-only";

import { basePrisma } from "@/lib/db";
import { runInTenantScope } from "@/lib/tenantScope";
import { getSetting } from "@/lib/settings";
import { isSmtpConfigured } from "@/lib/email";
import { isWhatsAppConfigured } from "@/lib/whatsapp";
import { isSmsConfigured } from "@/lib/sms";
import { isMessengerConfigured } from "@/lib/messenger";
import { isAiConfigured } from "@/lib/ai";
import { isElevenLabsConfigured } from "@/lib/elevenlabs";

/**
 * Per-tenant integration health for the platform console.
 *
 * Two independent signals per integration, because either alone misleads:
 *   - CONFIGURED: are the credentials present? Read by running the app's own
 *     config checks INSIDE the tenant's scope, so each tenant is asked about its
 *     own settings rather than a global one.
 *   - FAILING: has it errored recently? Taken from ErrorLog scopes, so a
 *     fully-configured integration that is throwing still reads as unhealthy —
 *     the case a configured-only view hides.
 *
 * The scope lists below are matched against the scopes `logError` actually uses
 * (grep `logError(` for the authoritative set). An integration whose scopes are
 * wrong would silently report healthy, so they are kept explicit rather than
 * guessed from the name.
 *
 * CAVEAT while tenant enforcement is dormant: `getSetting` reads AppSetting through
 * the guarded client, which only scopes by tenant once enforcement is ON. Until
 * then every tenant reads the same install-wide settings, so CONFIGURED will be
 * identical across tenants. The mechanism is correct and becomes per-tenant
 * automatically; the console says so rather than implying isolation it lacks.
 */

export type IntegrationId =
  | "email"
  | "whatsapp"
  | "sms"
  | "messenger"
  | "instagram"
  | "google_reviews"
  | "telegram"
  | "ai"
  | "voice";

export type IntegrationStatus = {
  id: IntegrationId;
  label: string;
  /** Short note shown under the label — e.g. shared credentials. */
  note?: string;
  configured: boolean;
  errors7d: number;
  lastError: { message: string; createdAt: Date } | null;
};

type IntegrationDef = {
  id: IntegrationId;
  label: string;
  note?: string;
  /** ErrorLog scopes that belong to this integration. */
  scopes: string[];
  configured: () => Promise<boolean>;
};

const DEFS: IntegrationDef[] = [
  {
    id: "email",
    label: "Email",
    scopes: ["smtp", "imap-sync"],
    configured: isSmtpConfigured,
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    scopes: ["whatsapp-webhook"],
    configured: isWhatsAppConfigured,
  },
  {
    id: "sms",
    label: "SMS",
    scopes: ["sms"],
    configured: isSmsConfigured,
  },
  {
    id: "messenger",
    label: "Facebook Messenger",
    note: "Shares the Meta page token with Instagram",
    // meta-dm-webhook carries BOTH Messenger and Instagram DMs, and meta-lead-sync
    // is Facebook lead ads. Neither can be split further from the scope alone.
    scopes: ["meta-dm-webhook", "meta-lead-sync"],
    configured: isMessengerConfigured,
  },
  {
    id: "instagram",
    label: "Instagram",
    note: "Shares the Meta page token with Messenger",
    scopes: ["meta-dm-webhook"],
    // Instagram DMs go through the same META_PAGE_ACCESS_TOKEN as Messenger
    // (see messenger.ts DmPlatform), so it is configured exactly when Messenger is.
    configured: isMessengerConfigured,
  },
  {
    id: "google_reviews",
    label: "Google Reviews",
    scopes: ["google-reviews"],
    configured: async () => {
      const [key, placeId] = await Promise.all([
        getSetting("GOOGLE_PLACES_API_KEY"),
        getSetting("GOOGLE_PLACE_ID"),
      ]);
      // Both are needed: a key without a place id fetches nothing.
      return Boolean(key && placeId);
    },
  },
  {
    id: "telegram",
    label: "Telegram bot",
    scopes: ["telegram-webhook", "bot-ai"],
    configured: async () => Boolean(await getSetting("TELEGRAM_BOT_TOKEN")),
  },
  {
    id: "ai",
    label: "AI (Anthropic)",
    scopes: ["ai-research", "ai-auto-research", "ai-check", "ai-health", "competitor-ai"],
    configured: isAiConfigured,
  },
  {
    id: "voice",
    label: "Voice (ElevenLabs)",
    scopes: ["elevenlabs-stt", "elevenlabs-tts", "voice-transcribe"],
    configured: isElevenLabsConfigured,
  },
];

/** Integration health for ONE tenant. */
export async function getTenantIntegrationHealth(
  tenantId: string,
): Promise<IntegrationStatus[]> {
  // Config probes read settings; run them inside the tenant's scope so that, under
  // enforcement, each tenant is asked about its own credentials. A single broken
  // probe must never take down the whole health view.
  const configured = await runInTenantScope({ tenantId, system: false }, async () =>
    Promise.all(DEFS.map((def) => def.configured().catch(() => false))),
  );

  const since = new Date(Date.now() - 7 * 24 * 3600_000);
  const errors = await basePrisma.errorLog.findMany({
    where: { tenantId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    select: { scope: true, message: true, createdAt: true },
    take: 500,
  });

  return DEFS.map((def, index) => {
    const mine = errors.filter((error) => def.scopes.includes(error.scope.toLowerCase()));
    return {
      id: def.id,
      label: def.label,
      note: def.note,
      configured: configured[index],
      errors7d: mine.length,
      lastError: mine[0] ? { message: mine[0].message, createdAt: mine[0].createdAt } : null,
    };
  });
}

/** Overall verdict, for badge colouring and sorting. */
export function integrationVerdict(
  status: IntegrationStatus,
): "failing" | "ok" | "not_configured" {
  // Errors win over "configured": an integration that looks set up but is throwing
  // is the most important thing to surface, and what a config-only view misses.
  if (status.errors7d > 0) return "failing";
  return status.configured ? "ok" : "not_configured";
}
