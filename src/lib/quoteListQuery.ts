import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { getAccessibleQuoteIds, type PermissionUser } from "./permissions";
import { matchingFleetIds, quoteListWhere } from "./quoteList";

/**
 * The quotes list filters for THIS user — RBAC scope plus search — used by both
 * the list page and the CSV export, so the two can never disagree about which
 * quotes a person may see.
 *
 * Fleet names are resolved first because `Quote.fleetId` is a bare scalar with
 * no relation to filter through (and gets none: a schema-only relation would be
 * permanent migrate-diff drift). The fleet query only narrows quotes that are
 * already bounded by `accessibleIds`, so it cannot widen what anyone sees.
 */
export async function quoteListFilter(
  user: PermissionUser,
  filters: { q?: string | null; status?: string | null },
): Promise<{ where: Prisma.QuoteWhereInput; all: Prisma.QuoteWhereInput }> {
  const q = filters.q?.trim() ?? "";
  const [accessibleIds, fleetIds] = await Promise.all([
    getAccessibleQuoteIds(user),
    // The scoped client: tenant-scoped like every other read here.
    matchingFleetIds(prisma, q),
  ]);
  return {
    // What the list shows and the export writes.
    where: quoteListWhere({ accessibleIds, status: filters.status || null, q, fleetIds }),
    // Every quote this user may see, unfiltered — for the headline figures.
    all: quoteListWhere({ accessibleIds }),
  };
}
