import webpush from "web-push";
import { prisma, basePrisma } from "./db";
import { getSetting } from "./settings";
import { isAllowedPushEndpoint } from "./pushEndpoint";
import { currentScopeClass } from "./tenantWrite";

type PushRecipient = { id: string; endpoint: string; p256dh: string; auth: string };

const PUSH_TIMEOUT_MS = 10_000;

/** Every device belonging to ONE named tenant, whatever the enforcement mode. */
export async function pushRecipientsForTenant(tenantId: string): Promise<PushRecipient[]> {
  return basePrisma.$queryRaw<PushRecipient[]>`
    SELECT ps."id", ps."endpoint", ps."p256dh", ps."auth"
    FROM "PushSubscription" ps
    JOIN "TenantMember" m ON m."userId" = ps."userId"
    JOIN "Tenant" t ON t."id" = m."tenantId"
    JOIN "User" u ON u."id" = ps."userId"
    WHERE m."tenantId" = ${tenantId} AND t."active" = true AND u."disabledAt" IS NULL`;
}

export async function pushRecipientsForCurrentScope(): Promise<PushRecipient[]> {
  const s = currentScopeClass();
  if (s.mode === "closed") {
    // A scopeless tenant push must fail closed, but it also needs to be visible in
    // diagnostics; otherwise a wiring fault looks exactly like zero subscriptions.
    const { logError } = await import("./errorLog");
    await logError(
      "push",
      new Error("Push requested with no tenant scope"),
      "A notification was dropped because no workspace was attached to the request. The sending path needs to establish a tenant scope (or name a tenant explicitly) before it calls sendPushToAll.",
      { tenantId: null, alert: false },
    );
    return [];
  }
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

export function pushConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
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
  const value = await getSetting("PUSH_DISABLED_KINDS");
  if (!value) return false;
  return value.split(",").includes(kind);
}

/**
 * Sends a push notification to subscribed devices; prunes dead subscriptions.
 *
 * `tenantId` restricts customer data to one workspace. `endpoint` is an optional
 * second restriction used by the interactive diagnostic so a test can prove the
 * phone in the user's hand works instead of succeeding because some other saved
 * device accepted the broadcast. The endpoint never creates a recipient: it only
 * filters the already-authorised recipient set resolved above.
 */
export async function sendPushToAll(
  payload: {
    title: string;
    body: string;
    url?: string;
  },
  kind?: PushKind,
  options: { tenantId?: string | null; endpoint?: string | null } = {},
): Promise<number> {
  if (!ensureConfigured()) return 0;
  if (await isKindDisabled(kind)) return 0;

  const recipients = options.tenantId
    ? await pushRecipientsForTenant(options.tenantId)
    : await pushRecipientsForCurrentScope();
  const subs = options.endpoint
    ? recipients.filter((sub) => sub.endpoint === options.endpoint)
    : recipients;

  let sent = 0;
  await Promise.all(
    subs.map(async (sub) => {
      if (!isAllowedPushEndpoint(sub.endpoint)) {
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        return;
      }
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ ...payload, kind }),
          { timeout: PUSH_TIMEOUT_MS },
        );
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        }
      }
    }),
  );
  return sent;
}
