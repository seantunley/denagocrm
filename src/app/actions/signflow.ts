"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { blankWorkflow, parseGraph } from "@/lib/signflow/model";
import { withActingStaffScope } from "@/lib/actingScope";

const BASE = "/settings/signing-workflows";

/** Create a workflow seeded with the default Denago→customer chain, then open it. */
export async function createSignWorkflow(formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requirePermission("signing.manage");
    const name = String(formData.get("name") ?? "").trim() || "New signing workflow";
    const created = await prisma.signWorkflow.create({
      data: { name, graphJson: blankWorkflow() as object, createdById: user.id },
    });
    await logAudit({ action: "signflow.create", summary: `Created signing workflow “${name}”`, entityType: "SignWorkflow", entityId: created.id, user });
    revalidatePath(BASE);
    redirect(`/signing-workflows/${created.id}`);
  });
}

/** Persist the workflow graph (validated) + its name. */
export async function saveSignWorkflow(id: string, name: string, graphJson: string): Promise<{ ok: boolean; error?: string }> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("signing.manage");
    let parsed: unknown;
    try { parsed = JSON.parse(graphJson); } catch { return { ok: false, error: "Invalid graph" }; }
    const graph = parseGraph(parsed);
    if (!graph) return { ok: false, error: "Workflow structure is invalid" };
    if (!graph.nodes[graph.start]) return { ok: false, error: "The start node is missing" };

    const existing = await prisma.signWorkflow.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) return { ok: false, error: "Not found" };

    await prisma.signWorkflow.update({ where: { id }, data: { name: name.trim() || existing.name, graphJson: graph as object } });
    await logAudit({ action: "signflow.save", summary: `Saved signing workflow “${name}”`, entityType: "SignWorkflow", entityId: id, user });
    return { ok: true };
  });
}

export async function deleteSignWorkflow(id: string) {
  return withActingStaffScope(async () => {
    const user = await requirePermission("signing.manage");
    await prisma.signWorkflow.update({ where: { id }, data: { deletedAt: new Date() } });
    await logAudit({ action: "signflow.delete", summary: "Deleted a signing workflow", entityType: "SignWorkflow", entityId: id, user });
    revalidatePath(BASE);
    redirect(BASE);
  });
}

/** Rename convenience (from the list). */
export async function renameSignWorkflow(id: string, name: string): Promise<{ ok: boolean }> {
  return withActingStaffScope(async () => {
    await requirePermission("signing.manage");
    await prisma.signWorkflow.update({ where: { id }, data: { name: name.trim() || "Untitled" } });
    revalidatePath(BASE);
    return { ok: true };
  });
}
