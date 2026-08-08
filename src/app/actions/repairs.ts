"use server";

import { revalidatePath } from "next/cache";
import { requireTenantOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { asActionResult, refuse } from "@/lib/actionResult";
import { setRepairIssueIgnored } from "@/lib/repairs";

/**
 * Ignore / un-ignore one repair issue.
 *
 * `requireTenantOwner()` in EVERY action, not only on the page. A server action
 * is reachable by a direct POST, so the page guard is not the boundary — it is
 * the same rule stated where the mutation happens. It matches
 * `{ prefix: "/repairs", tenantOwner: true }` in routeAccess.ts.
 *
 * TENANT owner, not platform owner, for the same reason the route rule is:
 * `setRepairIssueIgnored` narrows by `repairsTenantId()`, so this action can
 * only ever touch the caller's own workspace. Requiring the platform role would
 * have left every other workspace's owner unable to dismiss their own issues.
 *
 * There is deliberately no "resolve" action. An issue is a statement about the
 * world, so the only thing that may retract it is the detector finding the
 * problem gone; a button that let a person mark a broken journey fixed would
 * make the page a to-do list that disagrees with reality. Ignore is the human
 * verb, and it hides rather than lies.
 */
export async function ignoreRepairIssue(id: string) {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    if (!(await setRepairIssueIgnored(id, true, user.id))) {
      refuse("That issue is no longer open — it may have cleared itself.");
    }
    await logAudit({ action: "repairs.ignore", summary: `Ignored repair issue ${id}`, user });
    revalidatePath("/repairs");
    return { success: "Ignored. It will come back if the problem clears and then recurs." };
  });
}

export async function restoreRepairIssue(id: string) {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    if (!(await setRepairIssueIgnored(id, false, user.id))) {
      refuse("That issue is no longer open — it may have cleared itself.");
    }
    await logAudit({ action: "repairs.restore", summary: `Restored repair issue ${id}`, user });
    revalidatePath("/repairs");
    return { success: "Back on the list." };
  });
}
