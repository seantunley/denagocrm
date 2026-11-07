import { basePrisma, prisma } from "./db";
import { isOverdueActivity } from "./activityDay";
import {
  getAccessibleContactIds,
  getAccessibleLeadIds,
  hasAnyPermission,
  type PermissionUser,
} from "./permissions";
import { actingTenantId } from "./actingTenant";
import { TenantScopeError } from "./tenantGuard";

/**
 * Activities inherit access from their linked lead/contact. General activities
 * without a linked CRM record remain visible only to their creator/assignee.
 */
export async function getAccessibleActivityIds(user: PermissionUser): Promise<string[] | null> {
  if (!(await hasAnyPermission(user, "activities.view", "activities.manage"))) return [];
  if (user.role === "owner") return null;

  const [leadIds, contactIds] = await Promise.all([
    getAccessibleLeadIds(user),
    getAccessibleContactIds(user),
  ]);
  let tenantId: string | null = null;
  try {
    tenantId = await actingTenantId();
  } catch (error) {
    if (!(error instanceof TenantScopeError)) throw error;
  }

  const rows = await basePrisma.activity.findMany({
    where: {
      OR: [
        { assignedToId: user.id },
        { createdById: user.id },
        { attendees: { some: { userId: user.id } } },
        // Staff availability is operationally useful only when the whole
        // workspace can see it. Keep the basePrisma read tenant-qualified.
        ...(tenantId ? [{ availabilityBlock: true, tenantId }] : []),
        ...(leadIds === null
          ? [{ leadId: { not: null } }]
          : leadIds.length
            ? [{ leadId: { in: leadIds } }]
            : []),
        ...(contactIds === null
          ? [{ contactId: { not: null } }]
          : contactIds.length
            ? [{ contactId: { in: contactIds } }]
            : []),
      ],
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * The sidebar's Activities badge: the page's "Overdue" tile on its default view —
 * my planned tasks (not calendar availability blocks), access-checked the same way.
 */
export async function overdueActivityCount(user: PermissionUser, now: Date = new Date()): Promise<number> {
  const ids = await getAccessibleActivityIds(user);
  if (ids !== null && ids.length === 0) return 0;
  const rows = await prisma.activity.findMany({
    where: {
      status: "planned",
      availabilityBlock: false,
      assignedToId: user.id,
      // Both overdue cases are before `now`; the exact all-day rule is applied below.
      dueDate: { lt: now },
      ...(ids === null ? {} : { id: { in: ids } }),
    },
    select: { dueDate: true, allDay: true },
  });
  return rows.filter((row) => isOverdueActivity(row, now)).length;
}
