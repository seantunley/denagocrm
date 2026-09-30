import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { containsText } from "./listPaging";
import { getAccessibleQuoteIds, type PermissionUser } from "./permissions";
import { quoteListWhere } from "./quoteList";

/**
 * The quotes list filters for THIS user — RBAC scope plus search — used by both
 * the list page and the CSV export, so the two can never disagree about which
 * quotes a person may see.
 *
 * Fleet names are resolved first because `Quote.fleetId` is a bare scalar with
 * no relation to filter through. The fleet query only narrows quotes that are
 * already bounded by `accessibleIds`, so it cannot widen what anyone sees.
 */
export async function quoteListFilter(
  user: PermissionUser,
  filters: { q?: string | null; status?: string | null },
): Promise<{ where: Prisma.QuoteWhereInput; all: Prisma.QuoteWhereInput }> {
  const q = filters.q?.trim() ?? "";
  const [accessibleIds, fleets] = await Promise.all([
    getAccessibleQuoteIds(user),
    q
      ? prisma.fleet.findMany({
          where: {
            deletedAt: null,
            OR: [{ name: containsText(q) }, { billingEmail: containsText(q) }, { billingPhone: containsText(q) }],
          },
          select: { id: true },
          take: 500,
        })
      : Promise.resolve([]),
  ]);
  return {
    // What the list shows and the export writes.
    where: quoteListWhere({
      accessibleIds,
      status: filters.status || null,
      q,
      fleetIds: fleets.map((fleet) => fleet.id),
    }),
    // Every quote this user may see, unfiltered — for the headline figures.
    all: quoteListWhere({ accessibleIds }),
  };
}
