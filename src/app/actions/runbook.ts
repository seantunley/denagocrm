"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { runSecurityChecks } from "@/lib/securityRunbook";

export async function runSecurityNow() {
  const user = await requireOwner();
  const run = await runSecurityChecks();
  await logAudit({
    action: "security.runbook",
    summary: `Security runbook executed — score ${run.score}% (${run.failed} failed, ${run.warned} warnings)`,
    user,
  });
  revalidatePath("/settings/security");
}
