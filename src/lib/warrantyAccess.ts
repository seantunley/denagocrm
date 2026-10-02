import "server-only";
import { prisma } from "@/lib/db";
import {
  canAccessVehicle,
  hasAnyPermission,
  requireAnyPermission,
  requireVehicleReadAccess,
  type PermissionUser,
} from "@/lib/permissions";

/**
 * Who may read a warranty claim: the warranty grant AND access to the claim's
 * vehicle. THE one rule — the claim page, its print routes and the document
 * builder all ask here.
 *
 * The print routes and the builder used to check only the vehicle, so someone
 * with vehicles.view_* but no warranty permission could open a claim's fault,
 * status and resolution through them while the claim's own page refused them
 * (review of #745).
 */
export const WARRANTY_READ = ["warranty.view", "warranty.manage"] as const;

/** For code that already holds the user and the claim's vehicle. */
export async function canReadWarrantyClaim(user: PermissionUser, vehicleId: string): Promise<boolean> {
  return (await hasAnyPermission(user, ...WARRANTY_READ)) && (await canAccessVehicle(user, vehicleId));
}

/**
 * Page / route guard. Redirects a caller without the warranty grant or the
 * vehicle, as the other require* guards do. Returns null when the claim does not
 * exist, so a page can notFound() and a route handler can answer 404.
 */
export async function requireWarrantyClaimReadAccess(
  claimId: string,
): Promise<{ user: PermissionUser; vehicleId: string } | null> {
  const user = await requireAnyPermission(...WARRANTY_READ);
  const claim = await prisma.warrantyClaim.findUnique({ where: { id: claimId }, select: { vehicleId: true } });
  if (!claim) return null;
  await requireVehicleReadAccess(claim.vehicleId);
  return { user, vehicleId: claim.vehicleId };
}
