import "server-only";
import { resolveTenantActor, resolveTenantMemberUser } from "@/lib/tenantActor";
import { tenantEnforcing } from "@/lib/tenantEnforcement";

export type ApproverStep = {
  assigneeType: string;
  assigneeUserId: string | null;
  assigneeRole: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
};

/** Resolve the intended approver strictly within the request tenant. */
export async function resolveApprover(step: ApproverStep): Promise<{ name: string; email: string | null }> {
  if (step.assigneeType === "staff") {
    const user = step.assigneeUserId ? await resolveTenantMemberUser(step.assigneeUserId) : null;
    if (user) return { name: user.name, email: user.email };
    if (tenantEnforcing()) return { name: step.assigneeName || "Approver", email: null };
  }
  if (step.assigneeType === "owner") {
    const user = await resolveTenantActor({ ownerOnly: true });
    if (user) return { name: user.name, email: user.email };
    if (tenantEnforcing()) return { name: step.assigneeName || "Approver", email: null };
  }
  return { name: step.assigneeName || step.assigneeRole || "Approver", email: step.assigneeEmail };
}
