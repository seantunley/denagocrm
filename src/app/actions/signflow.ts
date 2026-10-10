"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireTenantOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { blankWorkflow, parseGraph } from "@/lib/signflow/model";
import { withActingStaffScope } from "@/lib/actingScope";
import { actingTenantId } from "@/lib/actingTenant";
import { asActionResult, refuse } from "@/lib/actionResult";
import { requiredReason } from "@/lib/deleteReason";
import { ownedWorkflowWhere } from "@/lib/signflow/owned";

const BASE = "/settings/signing-workflows";
/** One answer for deleted, missing and another workspace's: a caller must not learn which. */
const GONE = "That workflow is no longer there — go back to the list.";

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
 *
 * AND EVERY ONE NAMES THE WORKSPACE. Being the owner says who is asking, not
 * whose workflow the id in the request is. Each write below is an `updateMany`
 * on `{ id, tenantId, deletedAt: null }` that must change exactly one row, so
 * an id from another workspace changes nothing and is answered exactly as a
 * missing one is. See lib/signflow/owned.ts for why the scoped client alone is
 * not enough.
 */

/** Create a workflow seeded with the default Denago→customer chain, then open it. */
export async function createSignWorkflow(formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requireTenantOwner();
    const name = String(formData.get("name") ?? "").trim() || "New signing workflow";
    const created = await prisma.signWorkflow.create({
      // Stamped here: the guard stamps nothing while enforcement is off, and a
      // workflow with no workspace is one its own creator could never open again.
      data: { tenantId: await actingTenantId(), name, graphJson: blankWorkflow() as object, createdById: user.id },
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

    const where = await ownedWorkflowWhere(id);
    const existing = await prisma.signWorkflow.findFirst({ where, select: { name: true } });
    if (!existing) return { ok: false, error: "Not found" };

    const saved = await prisma.signWorkflow.updateMany({ where, data: { name: name.trim() || existing.name, graphJson: graph as object } });
    if (saved.count !== 1) return { ok: false, error: "Not found" };
    await logAudit({ action: "signflow.save", summary: `Saved signing workflow “${name}”`, entityType: "SignWorkflow", entityId: id, user });
    return { ok: true };
  });
}

export async function deleteSignWorkflow(id: string, formData?: FormData) {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const reason = requiredReason(formData, "deleting this workflow");
    const where = await ownedWorkflowWhere(id);
    const wf = await prisma.signWorkflow.findFirst({ where, select: { name: true } });
    if (!wf) refuse(GONE);
    const removed = await prisma.signWorkflow.updateMany({ where, data: { deletedAt: new Date() } });
    if (removed.count !== 1) refuse(GONE);
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
    const renamed = await prisma.signWorkflow.updateMany({ where: await ownedWorkflowWhere(id), data: { name: name.trim() || "Untitled" } });
    revalidatePath(BASE);
    return { ok: renamed.count === 1 };
  });
}
