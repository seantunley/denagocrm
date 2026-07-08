"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCrm } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { contactName } from "@/lib/format";

/** Pays out an earned referral — the note records what was given at the time. */
export async function redeemReferral(referralId: string, formData: FormData) {
  const user = await requireCrm();
  const note = String(formData.get("note") ?? "").trim();
  if (!note) return; // what was given is mandatory for the paper trail
  const referral = await prisma.referral.findUnique({
    where: { id: referralId },
    include: { referrer: true },
  });
  if (!referral || referral.status !== "earned") return;
  await prisma.referral.update({
    where: { id: referralId },
    data: { status: "redeemed", redeemedAt: new Date(), redeemedNote: note },
  });
  await logAudit({
    action: "referral.redeemed",
    summary: `Referral fee redeemed by ${contactName(referral.referrer)} — ${note}`,
    contactId: referral.referrerId,
    user,
  });
  revalidatePath("/referrals");
  revalidatePath(`/contacts/${referral.referrerId}`);
}
