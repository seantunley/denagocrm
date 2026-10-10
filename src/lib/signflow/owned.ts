import "server-only";
import { prisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";

/**
 * ONE WORKFLOW, AND ONLY IF IT IS THIS WORKSPACE'S.
 *
 * A workflow reaches the owner's screens as an id — in a URL, or bound into a
 * form by the browser. `requireTenantOwner()` answers who is asking. It says
 * nothing about whose row that id names, and the scoped client only adds the
 * workspace to a query while tenant enforcement is ON. With it off — the
 * default everywhere but production, and the documented rollback — a lookup by
 * id alone returned any workspace's workflow, and the save, rename or delete
 * that followed changed it.
 *
 * So the workspace is named in the `where`, in both modes. Every read of a
 * single workflow on the owner's screens goes through here, and every write
 * spreads the same three conditions into an `updateMany` and checks that it
 * changed exactly one row (app/actions/signflow.ts).
 *
 * STRICT EQUALITY. A workflow with no workspace is nobody's — the rule
 * lib/flowTenantScope.ts states for chatbot flows and journeys, for the same
 * reason: nothing has been able to create one since the workspace was stamped
 * at creation, so a NULL row is not "old", it is "written by we do not know
 * whom". Production has none (counted 2026-10-10).
 */
export async function ownedWorkflowWhere(id: string) {
  return { id, tenantId: await actingTenantId(), deletedAt: null };
}

/** The workflow, or null if it is deleted, missing, or another workspace's — the caller cannot tell which. */
export async function ownedSignWorkflow(id: string) {
  return prisma.signWorkflow.findFirst({ where: await ownedWorkflowWhere(id) });
}
