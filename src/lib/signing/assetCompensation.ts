import "server-only";
import { basePrisma } from "@/lib/db";
import { deleteFile } from "@/lib/storage";

/**
 * A thrown transaction/commit acknowledgement does not prove PostgreSQL rolled
 * back. Delete a temporary signature asset only after an explicit tenant-scoped
 * read proves that neither a recipient nor a placed field durably references it.
 * Any lookup failure is uncertainty and therefore retains the object.
 */
export async function deleteUnreferencedSigningAssets(
  tenantId: string | null | undefined,
  refs: readonly string[],
): Promise<{ deleted: string[]; retained: string[] }> {
  const unique = [...new Set(refs.filter(Boolean))];
  const result = { deleted: [] as string[], retained: [] as string[] };
  if (!tenantId) {
    result.retained.push(...unique);
    return result;
  }

  for (const ref of unique) {
    try {
      const rows = await basePrisma.$queryRaw<Array<{ referenced: boolean }>>`
        SELECT (
          EXISTS (
            SELECT 1 FROM "SignatureRecipient"
            WHERE "tenantId" = ${tenantId} AND "signatureRef" = ${ref}
          )
          OR EXISTS (
            SELECT 1 FROM "SignatureField"
            WHERE "tenantId" = ${tenantId} AND "value" = ${ref}
          )
          OR EXISTS (
            SELECT 1 FROM "SignatureFieldResponse"
            WHERE "tenantId" = ${tenantId} AND "value" = ${ref}
          )
        ) AS "referenced"
      `;
      if (rows[0]?.referenced !== false) {
        result.retained.push(ref);
        continue;
      }
      await deleteFile(ref);
      result.deleted.push(ref);
    } catch {
      // Database or storage uncertainty keeps evidence. A later reconciliation
      // job can collect a true orphan; a deleted committed signature cannot be
      // reconstructed.
      result.retained.push(ref);
    }
  }
  return result;
}
