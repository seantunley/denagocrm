"use server";

import { asActionResult, refuse } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireContactAccess, requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { contactName } from "@/lib/format";
import { currentTenantScope } from "@/lib/tenantScope";

export async function redeemReferral(referralId: string, formData: FormData) {
  return asActionResult(async () => {
    // AUTHORISE BEFORE DISCLOSING ANYTHING.
    //
    // These refusals are deliberately specific — "already redeemed" is genuinely
    // useful — but specificity before an authorisation check turns the action
    // into an oracle: an unauthorised or expired session could probe referral ids
    // and read back whether each exists and what state it is in. That is worse
    // where no tenant scope is established, since the lookup is then unscoped.
    //
    // So: the capability is checked first, then the record is fetched and the
    // contact-scoped check applied, and only then may a message describe state.
    await requirePermission("referrals.manage");

    const note = String(formData.get("note") ?? "").trim();
    if (!note) refuse("Say what the referrer was given.");
    const tenantId = currentTenantScope()?.tenantId;
    const referral = await prisma.referral.findUnique({
      where: tenantId ? { id: referralId, tenantId } : { id: referralId },
      include: { referrer: true },
    });
    if (!referral) refuse("That referral no longer exists.");
    const user = await requireContactAccess(referral.referrerId, "referrals.manage");
    if (referral.status !== "earned") refuse(`That referral is already ${referral.status}.`);
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
