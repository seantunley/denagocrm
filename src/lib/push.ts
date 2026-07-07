import webpush from "web-push";
import { prisma } from "./db";

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
  { id: "booking", label: "Service bookings", desc: "Online booking lands in the workshop diary" },
  { id: "quote_viewed", label: "Quote opened", desc: "Customer views their signing link" },
  { id: "quote_signed", label: "Quote / job card signed", desc: "Customer signs online" },
  { id: "quote_feedback", label: "Quote declined / changes", desc: "Customer declines or requests changes" },
  { id: "review", label: "Google reviews", desc: "A new review appears" },
  { id: "email_in", label: "Email replies", desc: "A customer replies to an email (IMAP)" },
  { id: "referral", label: "Referral fees", desc: "A referred deal is won — fee due" },
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
  const subs = await prisma.pushSubscription.findMany();
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
