import crypto from "crypto";
import { prisma } from "./db";
import { logAudit } from "./audit";
import { sendPushToAll } from "./push";
import { contactName } from "./format";

// No 0/O/1/I — codes get read out over the phone
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(): string {
  const bytes = crypto.randomBytes(4);
  let out = "";
  for (let i = 0; i < 4; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `DGO-${out}`;
}

/** Every customer gets one permanent, unique referral code. */
export async function ensureReferralCode(contactId: string): Promise<string> {
  const contact = await prisma.contact.findUniqueOrThrow({ where: { id: contactId } });
  if (contact.referralCode) return contact.referralCode;
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomCode();
    try {
      await prisma.contact.update({ where: { id: contactId }, data: { referralCode: code } });
      return code;
    } catch {
      // unique collision — try another
    }
  }
  throw new Error("Could not allocate a referral code");
}

/**
 * Links a new lead to the referrer whose code was given. Silently ignores
 * unknown codes and self-referrals so lead capture never fails on a typo.
 */
export async function recordReferral(codeRaw: string, leadId: string): Promise<void> {
  const code = codeRaw.trim().toUpperCase();
  if (!code) return;
  const referrer = await prisma.contact.findFirst({ where: { referralCode: code } });
  if (!referrer) return;
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead || lead.contactId === referrer.id) return; // no self-referrals
  const existing = await prisma.referral.findUnique({ where: { leadId } });
  if (existing) return;
  await prisma.referral.create({
    data: { referrerId: referrer.id, leadId, contactId: lead.contactId },
  });
  await logAudit({
    action: "referral.recorded",
    summary: `Lead “${lead.title}” referred by ${contactName(referrer)} (${code})`,
    leadId,
    contactId: referrer.id,
    userName: "System",
  });
}

/** Called when a lead is won — the referrer's fee becomes due. */
export async function markReferralEarned(leadId: string): Promise<void> {
  const referral = await prisma.referral.findUnique({
    where: { leadId },
    include: { referrer: true, lead: true },
  });
  if (!referral || referral.status !== "pending") return;
  await prisma.referral.update({
    where: { id: referral.id },
    data: { status: "earned", earnedAt: new Date() },
  });
  await logAudit({
    action: "referral.earned",
    summary: `Referral fee earned by ${contactName(referral.referrer)} — referred deal “${referral.lead?.title ?? ""}” was won`,
    leadId,
    contactId: referral.referrerId,
    userName: "System",
  });
  const { runLeadAutomations } = await import("./automations");
  await runLeadAutomations("referral_earned", leadId).catch(() => {});
  await sendPushToAll({
    title: "Referral fee due 🎁",
    body: `${contactName(referral.referrer)} referred a won deal — sort out their reward`,
    url: `/referrals`,
  }, "referral").catch(() => {});
}
