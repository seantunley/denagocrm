"use server";

import { revalidatePath } from "next/cache";
import { asActionResult } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { actingTenantId } from "@/lib/actingTenant";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { requireModuleEnabled } from "@/lib/modules/enabled";
import { DISMISSABLE_SOURCES, SNOOZE_CHOICES, dismissUntil, parseItemKey, snoozeUntil } from "@/lib/myWork/dispositions";

/**
 * Snooze, dismiss or bring back an item on MY OWN list. A disposition is keyed by
 * the signed-in person, so nobody can change anyone else's list, and it never
 * touches the record the item is about (lib/myWork/dispositions.ts).
 */
export async function setWorkDisposition(formData: FormData) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      await requireModuleEnabled("work");
      const user = await requireUser();
      const item = parseItemKey(formData.get("itemKey"));
      if (!item) return { error: "That item is not on your list." };
      const tenantId = await actingTenantId();
      const where = { tenantId_userId_itemKey: { tenantId, userId: user.id, itemKey: item.key } };
      const now = new Date();
      const choice = String(formData.get("choice") ?? "");
      // The item's reason, numbers taken out (rules.fingerprintOf). Kept on snoozes too, so the owner's
      // "how suggestions land" counts know which rule an item came from. It only ever affects the caller's own row.
      const fingerprint = String(formData.get("fingerprint") ?? "").slice(0, 500) || null;

      if (choice === "restore") {
        await prisma.workDisposition.deleteMany({ where: { tenantId, userId: user.id, itemKey: item.key } });
        revalidatePath("/work");
        return { success: "Back on your list" };
      }
      if (choice === "dismiss") {
        // A task is done on its record, never dismissed (brief §6).
        if (!DISMISSABLE_SOURCES.has(item.type)) return { error: "A task leaves the list when it is done on its record — it can be snoozed, not dismissed." };
        const data = { action: "dismissed", until: dismissUntil(now), fingerprint };
        await prisma.workDisposition.upsert({ where, update: data, create: { tenantId, userId: user.id, itemKey: item.key, ...data } });
        revalidatePath("/work");
        return { success: "Dismissed — it comes back if its reason changes" };
      }
      const days = Number(choice.replace(/^snooze:/, ""));
      if (!choice.startsWith("snooze:") || !SNOOZE_CHOICES.some((c) => c.days === days)) return { error: "Pick how long to snooze it for." };
      const data = { action: "snoozed", until: snoozeUntil(days, now), fingerprint };
      await prisma.workDisposition.upsert({ where, update: data, create: { tenantId, userId: user.id, itemKey: item.key, ...data } });
      revalidatePath("/work");
      return { success: "Snoozed" };
    }),
  );
}
