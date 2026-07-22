import webpush from "web-push";
import { prisma, basePrisma } from "./db";
import { currentScopeClass } from "./tenantWrite";

type PushRecipient = { id: string; endpoint: string; p256dh: string; auth: string };

/**
 * The device subscriptions a push may be delivered to for the CURRENT tenant scope.
 * `PushSubscription` is a GLOBAL model (in the guard's allow-list), so tenant scope
 * does NOT filter it — a naive `findMany()` would send one tenant's customer data
 * (a new lead / booking name) to every other tenant's subscribed devices.
 *
 *   - `global`  (dormant OR trusted system scope) → EVERY subscription, unchanged.
 *   - `tenant`  → only devices of ACTIVE, non-disabled members of that tenant
 *                 (join through TenantMember → active Tenant, excluding disabled
 *                 users — a disabled account must not receive tenant data either).
 *   - `closed`  (enforcement on, no resolvable tenant) → NONE. A scopeless tenant
 *                 push must fail closed to nobody, never broadcast to everybody.
 *
 * Exported so scripts/test-tenant-guard.ts can prove the selection directly without
 * a live web-push transport.
 */
export async function pushRecipientsForCurrentScope(): Promise<PushRecipient[]> {
  const s = currentScopeClass();
  if (s.mode === "closed") return [];
  if (s.mode === "global") {
    return prisma.pushSubscription.findMany({
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
  }
  return basePrisma.$queryRaw<PushRecipient[]>`
    SELECT ps."id", ps."endpoint", ps."p256dh", ps."auth"
    FROM "PushSubscription" ps
    JOIN "TenantMember" m ON m."userId" = ps."userId"
    JOIN "Tenant" t ON t."id" = m."tenantId"
    JOIN "User" u ON u."id" = ps."userId"
    WHERE m."tenantId" = ${s.tenantId} AND t."active" = true AND u."disabledAt" IS NULL`;
}

let configured = false;
function ensureConfigured(): boolean {
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  if (!configured) {
    webpush.setVapidDetails("mailto:sean@denagocpt.co.za", pub, priv);
    configured = true;
  }
  return true;
}

/** Every push the CRM can send — shown as toggles in Settings → Notifications. */
export const PUSH_KINDS = [
  { id: "lead_new", label: "New lead", desc: "Facebook, Instagram, website or WhatsApp lead arrives" },
  { id: "dm", label: "Social DMs", desc: "New Messenger / Instagram message" },
  { id: "whatsapp", label: "WhatsApp messages", desc: "New inbound WhatsApp" },
  { id: "bot_handoff", label: "Bot hand-offs", desc: "The WhatsApp assistant hands a chat to a human" },
  { id: "booking", label: "Service bookings", desc: "Online booking lands in the workshop diary" },
  { id: "service_request", label: "Portal service requests", desc: "A customer requests a service from the portal" },
  { id: "portal_case", label: "Support cases", desc: "A customer opens or replies to a support case in the portal" },
  { id: "warranty", label: "Warranty claims", desc: "A customer lodges a warranty claim from the portal" },
  { id: "portal_profile", label: "Profile change requests", desc: "A customer requests a change to their contact details" },
  { id: "quote_viewed", label: "Quote opened", desc: "Customer views their signing link" },
  { id: "quote_signed", label: "Quote / job card signed", desc: "Customer signs online" },
  { id: "quote_feedback", label: "Quote declined / changes", desc: "Customer declines or requests changes" },
  { id: "review", label: "Google reviews", desc: "A new review appears" },
  { id: "email_in", label: "Email replies", desc: "A customer replies to an email (IMAP)" },
  { id: "referral", label: "Referral fees", desc: "A referred deal is won — fee due" },
  { id: "competitor", label: "Competitor changes", desc: "A material change on a monitored competitor page" },
  { id: "system_error", label: "System errors", desc: "Something in the CRM failed (throttled to 1/30min)" },
  { id: "security", label: "Security & AI health", desc: "Monthly runbook results and AI/billing problems — route to whoever owns security" },
  { id: "backup", label: "Backup failures", desc: "The nightly backup missed its window (throttled to 1/day)" },
  { id: "activity_reminder", label: "Meeting reminders", desc: "An hour before timed meetings/test drives — tap opens Google Maps" },
] as const;

export type PushKind = (typeof PUSH_KINDS)[number]["id"];

async function isKindDisabled(kind?: PushKind): Promise<boolean> {
  if (!kind) return false;
  const row = await prisma.appSetting.findUnique({ where: { key: "PUSH_DISABLED_KINDS" } });
  if (!row?.value) return false;
  return row.value.split(",").includes(kind);
}

/** Sends a push notification to every subscribed device; prunes dead subscriptions. */
export async function sendPushToAll(
  payload: {
    title: string;
    body: string;
    url?: string;
  },
  kind?: PushKind
): Promise<number> {
  if (!ensureConfigured()) return 0;
  if (await isKindDisabled(kind)) return 0;
  // Deliver only to the CURRENT tenant's devices (all devices when global/system).
  const subs = await pushRecipientsForCurrentScope();
  let sent = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload)
        );
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        }
      }
    })
  );
  return sent;
}
