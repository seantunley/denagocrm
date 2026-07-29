"use server";

import { asActionResult, refuse } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireContactAccess } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { contactName } from "@/lib/format";
import { currentTenantScope } from "@/lib/tenantScope";

export async function redeemReferral(referralId: string, formData: FormData) {
  return asActionResult(async () => {
    const note = String(formData.get("note") ?? "").trim();
    if (!note) refuse("Say what the referrer was given.");
    const tenantId = currentTenantScope()?.tenantId;
    const referral = await prisma.referral.findUnique({
      where: tenantId ? { id: referralId, tenantId } : { id: referralId },
      include: { referrer: true },
    });
    if (!referral) refuse("That referral no longer exists.");
    if (referral.status !== "earned") refuse(`That referral is already ${referral.status}.`);
    const user = await requireContactAccess(referral.referrerId, "referrals.manage");
    await prisma.referral.update({
      where: tenantId ? { id: referralId, tenantId } : { id: referralId },
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
  });
}
