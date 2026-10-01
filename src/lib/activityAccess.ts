import { basePrisma } from "./db";
import {
  getAccessibleContactIds,
  getAccessibleLeadIds,
  hasAnyPermission,
  type PermissionUser,
} from "./permissions";
import { actingTenantId } from "./actingTenant";

/**
 * Activities inherit access from their linked lead/contact. General activities
 * without a linked CRM record remain visible only to their creator/assignee.
 */
export async function getAccessibleActivityIds(user: PermissionUser): Promise<string[] | null> {
  if (!(await hasAnyPermission(user, "activities.view", "activities.manage"))) return [];
  if (user.role === "owner") return null;

  const [leadIds, contactIds, tenantId] = await Promise.all([
    getAccessibleLeadIds(user),
    getAccessibleContactIds(user),
    actingTenantId(),
  ]);

  const rows = await basePrisma.activity.findMany({
    where: {
      OR: [
        { assignedToId: user.id },
        { createdById: user.id },
        // Staff availability is operationally useful only when the whole
        // workspace can see it. Keep the basePrisma read tenant-qualified.
        { availabilityBlock: true, tenantId },
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
