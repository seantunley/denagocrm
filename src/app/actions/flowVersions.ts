"use server";

import { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { basePrisma, prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { builderOwnedWhere, builderTenantId } from "@/lib/flowTenantScopeServer";
import { logAudit } from "@/lib/audit";

type VersionRow = { id: string; version: number; definition: string };

/**
 * Restore an immutable published snapshot into the MUTABLE DRAFT only. Customers
 * remain on the currently published version until the owner separately runs the
 * normal simulator/compiler/Publish path.
 */
export async function restoreFlowVersionToDraft(
  flowId: string,
  versionId: string,
  formData: FormData,
) {
  const owner = await requireOwner();
  const expectedUpdatedAt = new Date(String(formData.get("expectedUpdatedAt") ?? ""));
  if (Number.isNaN(expectedUpdatedAt.getTime())) return;
  const tenantId = builderTenantId();

  const rows = await basePrisma.$queryRaw<VersionRow[]>(Prisma.sql`
    SELECT "id", "version", "definition"
      FROM "BotFlowVersion"
     WHERE "tenantId" = ${tenantId}
       AND "flowId" = ${flowId}
       AND "id" = ${versionId}
     LIMIT 1
  `);
  const version = rows[0];
  if (!version) return;

  // Optimistic concurrency: the button is tied to the draft state the owner saw.
  // A canvas save that lands after the history page rendered wins; rollback then
  // does nothing instead of overwriting newer work.
  //
  // The tenant is named on the DRAFT too, not just on the version read above. The
  // two are separate rows: the version lookup proves the snapshot is ours, it does
  // not prove the BotFlow row `flowId` points at is (they are joined by a plain
  // scalar FK, which the guard and RLS both leave unchecked across rows).
  const updated = await prisma.botFlow.updateMany({
    where: { id: flowId, updatedAt: expectedUpdatedAt, ...builderOwnedWhere() },
    data: { definition: version.definition },
  });
  if (updated.count !== 1) return;

  await logAudit({
    action: "bot.flow_version_restored",
    summary: `Restored chatbot flow version ${Number(version.version)} into the draft; live publication was unchanged`,
    user: owner,
  });
  revalidatePath(`/bot-builder/${flowId}`);
  revalidatePath(`/bot-builder/${flowId}/versions`);
  revalidatePath("/bot-builder");
  redirect(`/bot-builder/${flowId}`);
}
