"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireContactAccess } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { contactName } from "@/lib/format";

export async function redeemReferral(referralId: string, formData: FormData) {
  const note = String(formData.get("note") ?? "").trim();
  if (!note) return;
  const referral = await prisma.referral.findUnique({
    where: { id: referralId },
    include: { referrer: true },
  });
  if (!referral || referral.status !== "earned") return;
  const user = await requireContactAccess(referral.referrerId, "referrals.manage");
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
