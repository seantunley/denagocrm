import { redirect } from "next/navigation";
import { basePrisma } from "./db";
import {
  getAccessibleContactIds,
  getAccessibleJobCardIds,
  getAccessibleQuoteIds,
  getAccessibleVehicleIds,
  hasPermission,
  requireAnyPermission,
  requirePermission,
  type PermissionKey,
  type PermissionUser,
} from "./permissions";

/**
 * Document scope is a union of accessible linked records plus files uploaded by
 * the user. An unrestricted contact/quote/vehicle scope grants all documents
 * linked to that record type, but never unrelated unfiled documents.
 */
export async function getAccessibleDocumentIds(user: PermissionUser): Promise<string[] | null> {
  if (await hasPermission(user, "documents.view_all")) return null;
  if (!(await hasPermission(user, "documents.view_owned"))) return [];

  const [contactIds, quoteIds, vehicleIds, jobCardIds] = await Promise.all([
    getAccessibleContactIds(user),
    getAccessibleQuoteIds(user),
    getAccessibleVehicleIds(user),
    getAccessibleJobCardIds(user),
  ]);

  const rows = await basePrisma.document.findMany({
    where: {
      deletedAt: null,
      OR: [
        { uploadedById: user.id },
        ...(contactIds === null
          ? [{ contactId: { not: null } }]
          : contactIds.length
            ? [{ contactId: { in: contactIds } }]
            : []),
        ...(quoteIds === null
          ? [{ quoteId: { not: null } }]
          : quoteIds.length
            ? [{ quoteId: { in: quoteIds } }]
            : []),
        ...(vehicleIds === null
          ? [{ vehicleId: { not: null } }]
          : vehicleIds.length
            ? [{ vehicleId: { in: vehicleIds } }]
            : []),
        ...(jobCardIds === null
          ? [{ jobCardId: { not: null } }]
          : jobCardIds.length
            ? [{ jobCardId: { in: jobCardIds } }]
            : []),
      ],
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

export async function canAccessDocument(user: PermissionUser, documentId: string): Promise<boolean> {
  const ids = await getAccessibleDocumentIds(user);
  return ids === null || ids.includes(documentId);
}

export async function requireDocumentReadAccess(documentId: string): Promise<PermissionUser> {
  const user = await requireAnyPermission("documents.view_all", "documents.view_owned");
  if (!(await canAccessDocument(user, documentId))) redirect("/documents");
  return user;
}

export async function requireDocumentAccess(
  documentId: string,
  permission: PermissionKey = "documents.manage"
): Promise<PermissionUser> {
  const user = await requirePermission(permission);
  if (!(await canAccessDocument(user, documentId))) redirect("/documents");
  return user;
}
