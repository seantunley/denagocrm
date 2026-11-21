"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, refuse } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { getActiveTenantId, isTenantOwner, requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { cleanNotice } from "@/lib/signatureNotices";

/*
 * Dated signature lines (lib/signatureNotices.ts). Anyone adds and removes their own; the workspace owner adds lines
 * for everyone and may remove any line. Part of the Email signatures pack. Every write names the workspace, and a line
 * is checked to be this workspace's before it is touched.
 */

const PAGE = "/email-signatures";
/** A person may have this many lines on and to come; the workspace this many for everyone. */
const OWN_MAX = 10;
const EVERYONE_MAX = 20;

async function workspace() {
  const user = await requireUser();
  if (!(await isModuleEnabled("signatures"))) refuse("Email signatures is switched off for this workspace.");
  const tenantId = await getActiveTenantId();
  if (!tenantId) return refuse("No workspace attached to this sign-in — sign out and back in.");
  return { user, tenantId };
}

/** Add a dated line: the person's own, or (`for` = "everyone", owner only) one on everyone's signature. */
export async function addSignatureNotice(formData: FormData) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const { user, tenantId } = await workspace();
      const forEveryone = formData.get("for") === "everyone";
      if (forEveryone && !(await isTenantOwner())) refuse("Only the workspace owner can add a line to everyone's signature.");
      const now = new Date();
      const notice = cleanNotice(
        { text: String(formData.get("text") ?? ""), startsOn: String(formData.get("startsOn") ?? ""), endsOn: String(formData.get("endsOn") ?? "") },
        now,
      );
      if (!notice.ok) return refuse(notice.error);
      const userId = forEveryone ? null : user.id;
      const count = await prisma.signatureNotice.count({ where: { tenantId, userId, endsAt: { gt: now } } });
      if (count >= (forEveryone ? EVERYONE_MAX : OWN_MAX)) refuse("That's the most dated lines at once. Remove one you no longer need first.");
      await prisma.signatureNotice.create({
        data: { tenantId, userId, text: notice.text, startsAt: notice.startsAt, endsAt: notice.endsAt, createdById: user.id },
      });
      await logAudit({
        action: "email_signature.notice_added",
        summary: `Dated signature line added ${forEveryone ? "for everyone" : "to their own signature"}: "${notice.text}"`,
        user,
      });
      revalidatePath(PAGE);
      return { success: "Saved — it shows on the days you chose" };
    }),
  );
}

/** Remove a line: your own, or any of this workspace's if you own it. */
export async function removeSignatureNotice(formData: FormData) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const { user, tenantId } = await workspace();
      const id = String(formData.get("id") ?? "");
      // The row's workspace at the door: an id from another workspace is "not found", never touched.
      const row = await prisma.signatureNotice.findFirst({ where: { id, tenantId }, select: { id: true, userId: true, text: true } });
      if (!row) return refuse("That line is already gone.");
      if (row.userId !== user.id && !(await isTenantOwner())) refuse("Only the workspace owner can remove someone else's line.");
      await prisma.signatureNotice.deleteMany({ where: { id: row.id, tenantId } });
      await logAudit({ action: "email_signature.notice_removed", summary: `Dated signature line removed: "${row.text}"`, user });
      revalidatePath(PAGE);
      return { success: "Removed" };
    }),
  );
}
