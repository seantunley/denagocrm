import type { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";
import {
  canAccessContact,
  canAccessLead,
  getAccessibleContactIds,
  getAccessibleLeadIds,
  requireAnyPermission,
  requirePermission,
  type PermissionUser,
} from "@/lib/permissions";
import { prisma } from "@/lib/db";

/**
 * Test drives follow the same ownership boundary as the customer/lead they belong
 * to, while the assigned and accompanying salespeople always retain access.
 */
export async function accessibleTestDriveWhere(
  user: PermissionUser,
): Promise<Prisma.TestDriveBookingWhereInput> {
  if (user.role === "owner") return {};

  const [contactIds, leadIds] = await Promise.all([
    getAccessibleContactIds(user),
    getAccessibleLeadIds(user),
  ]);

  // Every booking has a contact. Contact view-all therefore grants the same
  // complete test-drive view an owner would have.
  if (contactIds === null) return {};

  const or: Prisma.TestDriveBookingWhereInput[] = [
    { salespersonId: user.id },
    { accompanyingSalespersonId: user.id },
  ];
  if (contactIds.length) or.push({ contactId: { in: contactIds } });
  if (leadIds === null) or.push({ leadId: { not: null } });
  else if (leadIds.length) or.push({ leadId: { in: leadIds } });

  return { OR: or };
}

export async function canAccessTestDriveBooking(
  user: PermissionUser,
  bookingId: string,
): Promise<boolean> {
  const scope = await accessibleTestDriveWhere(user);
  const row = await prisma.testDriveBooking.findFirst({
    where: { id: bookingId, deletedAt: null, ...scope },
    select: { id: true },
  });
  return Boolean(row);
}

export async function requireTestDriveReadAccess(bookingId: string): Promise<PermissionUser> {
  const user = await requireAnyPermission("activities.view", "activities.manage");
  if (!(await canAccessTestDriveBooking(user, bookingId))) redirect("/test-drives");
  return user;
}

export async function requireTestDriveManageAccess(bookingId: string): Promise<PermissionUser> {
  const user = await requirePermission("activities.manage");
  if (!(await canAccessTestDriveBooking(user, bookingId))) {
    throw new Error("You do not have access to this test-drive booking");
  }
  return user;
}

export async function assertTestDriveCustomerAccess(
  user: PermissionUser,
  contactId: string,
  leadId: string | null,
): Promise<void> {
  if (!(await canAccessContact(user, contactId))) {
    throw new Error("You do not have access to that customer");
  }
  if (leadId && !(await canAccessLead(user, leadId))) {
    throw new Error("You do not have access to that lead");
  }
}
