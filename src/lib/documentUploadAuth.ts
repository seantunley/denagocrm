import "server-only";

import { basePrisma } from "./db";
import {
  requireContactAccess,
  requireJobCardAccess,
  requirePermission,
  requireQuoteAccess,
  requireVehicleAccess,
  type PermissionUser,
} from "./permissions";
import type { UploadTarget } from "./documentFolders";

/**
 * May the signed-in user file a document on this target, in this workspace?
 *
 * Asked TWICE for every direct upload, deliberately: by the token route before
 * it signs an upload, and again by the register action before it records the
 * stored file. The token proves the upload was authorised when it started; the
 * register step must not trust that the same person, record and workspace still
 * hold by the time it finishes.
 *
 * The permission checks are the same ones the Server Action upload path uses
 * (`documents.upload`, scoped to the record). The workspace check is the one the
 * photo route adds: the record must belong to the workspace the upload path is
 * written under, so a record id from another workspace cannot be used to put a
 * file there — or to put one of theirs here.
 */
export async function authorizeDocumentTarget(target: UploadTarget, tenantId: string): Promise<PermissionUser> {
  if (target.kind === "company") return requirePermission("documents.upload");

  const { field, id } = target;
  let user: PermissionUser;
  let inWorkspace: { id: string } | null;
  switch (field) {
    case "contactId":
      user = await requireContactAccess(id, "documents.upload");
      inWorkspace = await basePrisma.contact.findFirst({ where: { id, tenantId }, select: { id: true } });
      break;
    case "vehicleId":
      user = await requireVehicleAccess(id, "documents.upload");
      inWorkspace = await basePrisma.vehicle.findFirst({ where: { id, tenantId }, select: { id: true } });
      break;
    case "jobCardId":
      user = await requireJobCardAccess(id, "documents.upload");
      inWorkspace = await basePrisma.jobCard.findFirst({ where: { id, tenantId }, select: { id: true } });
      break;
    case "quoteId":
      user = await requireQuoteAccess(id, "documents.upload");
      inWorkspace = await basePrisma.quote.findFirst({ where: { id, tenantId }, select: { id: true } });
      break;
  }
  if (!inWorkspace) throw new Error("That record is not available in the active workspace.");
  return user;
}
