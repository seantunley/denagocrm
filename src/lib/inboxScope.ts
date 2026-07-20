/**
 * Pure, DB-free helper for scoping the social inbox (Communication rows) to the
 * records a user may see. Kept free of Prisma/DB side effects so the branching
 * logic is unit-testable in isolation; the DB-backed `accessibleInboxWhere` in
 * permissions.ts resolves the scope and delegates the shape decision to here.
 *
 * `contactIds`/`leadIds` follow the getAccessible*Ids convention: `null` means
 * "all of that entity", an array is the explicit allow-list (empty → none).
 */
import type { Prisma } from "@prisma/client";

export type InboxAccessScope = {
  contactsViewAll: boolean;
  leadsViewAll: boolean;
  contactIds: string[] | null;
  leadIds: string[] | null;
};

export function inboxWhereForScope(scope: InboxAccessScope): Prisma.CommunicationWhereInput {
  // Fully privileged for BOTH entities → no record filter at all.
  if (scope.contactsViewAll && scope.leadsViewAll) return {};
  return {
    OR: [
      // `null` (all of that entity) → any row linked to one; array → allow-list;
      // empty array → `in: []` matches nothing (correctly scopes out).
      scope.contactIds === null
        ? { contactId: { not: null } }
        : { contactId: { in: scope.contactIds } },
      scope.leadIds === null
        ? { leadId: { not: null } }
        : { leadId: { in: scope.leadIds } },
    ],
  };
}
