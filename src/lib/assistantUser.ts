import "server-only";
import { basePrisma } from "./db";
import { hasAnyPermission, type PermissionKey, type PermissionUser } from "./permissions";
import { isModuleEnabled } from "./modules/enabled";
import { resolveTenantMemberUser } from "./tenantActor";

/** Who may use the assistant at all — the same set on every way in. */
export const ASSISTANT_PERMISSIONS = [
  "leads.view_all", "leads.view_owned",
  "quotes.view_all", "quotes.view_owned",
  "activities.view", "activities.manage",
] as const satisfies readonly PermissionKey[];

/**
 * The assistant acting for a person with NO browser session — a scheduled
 * request firing, a question sent from their phone. The caller has already
 * entered the workspace's tenant scope (the cron's per-tenant loop, the
 * webhook's channel scope); this re-checks, at the moment it runs, everything
 * a sign-in would: they are an active, non-disabled member of THIS workspace,
 * they still hold an assistant permission, and the Automation & AI module is
 * still on. Any of those gone → null, and nothing runs. The tools then apply
 * that person's own visibility exactly as on the page.
 */
export async function assistantUserFor(userId: string): Promise<PermissionUser | null> {
  const member = await resolveTenantMemberUser(userId);
  if (!member) return null;
  const user = await basePrisma.user.findUnique({ where: { id: member.id }, select: { id: true, name: true, email: true, role: true } });
  if (!user) return null;
  if (!(await hasAnyPermission(user, ...ASSISTANT_PERMISSIONS))) return null;
  if (!(await isModuleEnabled("automation"))) return null;
  return user;
}
