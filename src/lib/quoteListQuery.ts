import type { Prisma } from "@prisma/client";
import { getAccessibleQuoteIds, type PermissionUser } from "./permissions";
import { quoteListWhere } from "./quoteList";

/**
 * The quotes list filters for THIS user — RBAC scope plus search — used by both
 * the list page and the CSV export, so the two can never disagree about which
 * quotes a person may see.
 *
 * Search, the fleet's name included, is entirely inside the returned `where`.
 * It used to pre-fetch "fleets matching the query, take 500" and feed their ids
 * in, which silently dropped every quote billed to the 501st matching fleet from
 * both the list and the export.
 */
export async function quoteListFilter(
  user: PermissionUser,
  filters: { q?: string | null; status?: string | null },
): Promise<{ where: Prisma.QuoteWhereInput; all: Prisma.QuoteWhereInput }> {
  const accessibleIds = await getAccessibleQuoteIds(user);
  return {
    // What the list shows and the export writes.
    where: quoteListWhere({ accessibleIds, status: filters.status || null, q: filters.q?.trim() ?? "" }),
    // Every quote this user may see, unfiltered — for the headline figures.
    all: quoteListWhere({ accessibleIds }),
  };
}
