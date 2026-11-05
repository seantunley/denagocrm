"use server";

import { revalidatePath } from "next/cache";
import { requireTenantOwner } from "@/lib/auth";
import { basePrisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";
import { logAudit } from "@/lib/audit";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { draftFromGap } from "@/lib/knowledgeGaps";

/** DAX drafts a knowledge entry from a question the chatbot couldn't answer. It stays a draft until approved. */
export async function draftKnowledgeFromGap(gapId: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const owner = await requireTenantOwner();
    const tenantId = await actingTenantId();
    const result = await draftFromGap(tenantId, gapId);
    if (!result.ok) refuse(result.error);
    await logAudit({ action: "bot.knowledge_drafted_from_questions", summary: `DAX drafted chatbot knowledge “${result.title}” from customer questions`, user: owner });
    revalidatePath("/chatbot/knowledge");
    return { success: `Drafted “${result.title}” — check it below, then approve it` };
  });
}

/** Not something the chatbot should answer (or already handled): off the list. */
export async function dismissKnowledgeGap(gapId: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const owner = await requireTenantOwner();
    const tenantId = await actingTenantId();
    const { count } = await basePrisma.knowledgeGap.updateMany({ where: { id: gapId, tenantId, status: "open" }, data: { status: "dismissed" } });
    if (!count) refuse("That question was already drafted or dismissed — refresh the page.");
    await logAudit({ action: "bot.knowledge_gap_dismissed", summary: "Dismissed a question the chatbot couldn't answer", user: owner });
    revalidatePath("/chatbot/knowledge");
    return { success: "Dismissed" };
  });
}
