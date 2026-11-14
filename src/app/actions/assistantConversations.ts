"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireAnyPermission } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, refuse } from "@/lib/actionResult";
import { logAudit } from "@/lib/audit";
import { ASSISTANT_PERMISSIONS } from "@/lib/assistantUser";
import { cleanTitle, TRASH_DAYS } from "@/lib/assistantConversationRules";
import { ownedWriteTenantId } from "@/lib/tenantWrite";

/*
 * A person managing their OWN DAX conversations on the Ask page (Sean, 2026-11-14: "no rename or delete"): rename,
 * delete, restore. Every lookup and write is keyed on the conversation id AND the signed-in user's id AND the
 * workspace they're acting in, so anyone else's id — even the workspace owner's, even in the same workspace — is
 * simply not found. Same gate as asking. Audit summaries never carry the title: it names customers.
 */

const GONE = "That conversation is no longer there — refresh the page.";

async function gate() {
  const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
  if (!(await isModuleEnabled("automation"))) refuse("The assistant is part of the Automation & AI module, which is off for this workspace.");
  return user;
}

/** The caller's own conversation in this workspace — live, or deleted (still restorable) — or a refusal. */
async function ownConversation(id: string, userId: string, deleted: boolean) {
  const conversation = await prisma.assistantConversation.findFirst({
    where: {
      id: String(id),
      userId,
      tenantId: ownedWriteTenantId(),
      deletedAt: deleted ? { gte: new Date(Date.now() - TRASH_DAYS * 86_400_000) } : null,
    },
    select: { id: true, tenantId: true, updatedAt: true },
  });
  if (!conversation) refuse(GONE);
  return conversation;
}

export async function renameAssistantConversation(id: string, formData: FormData) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await gate();
      const title = cleanTitle(formData.get("title"));
      if (!title) refuse("Give it a name.");
      const conversation = await ownConversation(id, user.id, false);
      await prisma.assistantConversation.updateMany({
        where: { id: conversation.id, tenantId: conversation.tenantId, userId: user.id, deletedAt: null },
        // Its place in the list, and whether the next question continues it, is when it last MOVED — not this.
        data: { title, updatedAt: conversation.updatedAt },
      });
      await logAudit({ action: "assistant.conversation_renamed", summary: "Renamed a DAX conversation", user, entityType: "AssistantConversation", entityId: conversation.id });
      revalidatePath("/assistant");
      return { success: "Renamed" };
    }),
  );
}

export async function deleteAssistantConversation(id: string) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await gate();
      const conversation = await ownConversation(id, user.id, false);
      await prisma.assistantConversation.updateMany({
        where: { id: conversation.id, tenantId: conversation.tenantId, userId: user.id, deletedAt: null },
        data: { deletedAt: new Date(), updatedAt: conversation.updatedAt },
      });
      await logAudit({ action: "assistant.conversation_deleted", summary: "Deleted a DAX conversation", user, entityType: "AssistantConversation", entityId: conversation.id });
      revalidatePath("/assistant");
      return { success: `Deleted — you can restore it for ${TRASH_DAYS} days` };
    }),
  );
}

export async function restoreAssistantConversation(id: string) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await gate();
      const conversation = await ownConversation(id, user.id, true);
      await prisma.assistantConversation.updateMany({
        where: { id: conversation.id, tenantId: conversation.tenantId, userId: user.id, deletedAt: { not: null } },
        data: { deletedAt: null, updatedAt: conversation.updatedAt },
      });
      await logAudit({ action: "assistant.conversation_restored", summary: "Restored a DAX conversation", user, entityType: "AssistantConversation", entityId: conversation.id });
      revalidatePath("/assistant");
      return { success: "Restored" };
    }),
  );
}
