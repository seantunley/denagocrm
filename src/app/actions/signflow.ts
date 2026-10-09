"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireTenantOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { blankWorkflow, parseGraph } from "@/lib/signflow/model";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult } from "@/lib/actionResult";
import { requiredReason } from "@/lib/deleteReason";

const BASE = "/settings/signing-workflows";

/*
 * Every action here is the workspace OWNER's, like the two screens that call
 * them (settings/signing-workflows and signing-workflows/[id]).
 *
 * They used to ask for `signing.manage` — the permission for sending and chasing
 * a document. A workflow is the rule that says whose approval a document needs
 * before a customer may sign it, so anyone who could send a quote for signature
 * could also rewrite the approval their own quote had to pass. It never
 * mattered only because no role could hold `signing.manage`; it does the moment
 * one can.
 */

/** Create a workflow seeded with the default Denago→customer chain, then open it. */
export async function createSignWorkflow(formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requireTenantOwner();
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
    const user = await requireTenantOwner();
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

export async function deleteSignWorkflow(id: string, formData?: FormData) {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const reason = requiredReason(formData, "deleting this workflow");
    const wf = await prisma.signWorkflow.update({ where: { id }, data: { deletedAt: new Date() }, select: { name: true } });
    await logAudit({ action: "signflow.delete", summary: `Deleted the signing workflow “${wf.name}” — ${reason}`, entityType: "SignWorkflow", entityId: id, user });
    revalidatePath(BASE);
    // Returned, not thrown: the confirmation dialog navigates only on success.
    return { redirectTo: BASE };
  });
}

/** Rename convenience (from the list). */
export async function renameSignWorkflow(id: string, name: string): Promise<{ ok: boolean }> {
  return withActingStaffScope(async () => {
    await requireTenantOwner();
    await prisma.signWorkflow.update({ where: { id }, data: { name: name.trim() || "Untitled" } });
    revalidatePath(BASE);
    return { ok: true };
  });
}
