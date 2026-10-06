"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireAnyPermission } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, refuse } from "@/lib/actionResult";
import { logAudit } from "@/lib/audit";
import { ASSISTANT_PERMISSIONS } from "@/lib/assistantUser";
import { MAX_ACTIVE_WATCHES, ONE_SHOT_KINDS, type WatchKind } from "@/lib/assistantWatchRules";
import { withWatchSlot } from "@/lib/assistantWatch";
import { ownedWriteTenantId } from "@/lib/tenantWrite";

/*
 * A person managing their OWN watches on the Ask page: pause, resume, delete.
 * Every lookup and write is keyed on the watch id AND the signed-in user's id
 * AND the workspace they're acting in, so someone else's id — even in the same
 * workspace — is simply not found. Same gate as asking: an assistant
 * permission and the Automation & AI module. Audit summaries name the kind
 * only — a watch's label carries a customer's name.
 */

const GONE = "That watch is no longer there — refresh the page.";

async function gate() {
  const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
  if (!(await isModuleEnabled("automation"))) refuse("The assistant is part of the Automation & AI module, which is off for this workspace.");
  return user;
}

/** The caller's own watch, in the workspace they're acting in — or a refusal. */
async function ownWatch(id: string, userId: string) {
  const watch = await prisma.assistantWatch.findFirst({
    where: { id: String(id), userId, tenantId: ownedWriteTenantId() },
    select: { id: true, tenantId: true, kind: true, active: true, lastFiredAt: true },
  });
  if (!watch) refuse(GONE);
  return watch;
}

const kindName = (kind: string) => kind.replace(/_/g, " ");

export async function setAssistantWatchActive(id: string, active: boolean) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await gate();
      const watch = await ownWatch(id, user.id);
      if (watch.active === Boolean(active)) return { success: active ? "Already watching" : "Already paused" };
      if (!active) {
        await prisma.assistantWatch.updateMany({ where: { id: watch.id, tenantId: watch.tenantId, userId: user.id }, data: { active: false } });
      } else {
        // "Tell me when she opens it" has told you: running it again would only say it again.
        if (ONE_SHOT_KINDS.includes(watch.kind as WatchKind) && watch.lastFiredAt) refuse("That one has already told you — ask for a new one instead.");
        const resumed = await withWatchSlot(watch.tenantId, user.id, (tx) =>
          tx.assistantWatch.updateMany({ where: { id: watch.id, tenantId: watch.tenantId, userId: user.id }, data: { active: true } }),
        );
        if (!resumed) refuse(`You already have ${MAX_ACTIVE_WATCHES} watches running — pause or delete one first.`);
      }
      await logAudit({
        action: active ? "assistant.watch_resumed" : "assistant.watch_paused",
        summary: `${active ? "Resumed" : "Paused"} an assistant watch (${kindName(watch.kind)})`,
        user, entityType: "AssistantWatch", entityId: watch.id,
      });
      revalidatePath("/assistant");
      return { success: active ? "Resumed" : "Paused" };
    }),
  );
}

export async function deleteAssistantWatch(id: string) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await gate();
      const watch = await ownWatch(id, user.id);
      // What it already told you stays in your history; only the watch goes.
      await prisma.assistantWatch.deleteMany({ where: { id: watch.id, tenantId: watch.tenantId, userId: user.id } });
      await logAudit({
        action: "assistant.watch_deleted",
        summary: `Deleted an assistant watch (${kindName(watch.kind)})`,
        user, entityType: "AssistantWatch", entityId: watch.id,
      });
      revalidatePath("/assistant");
      return { success: "Deleted" };
    }),
  );
}
