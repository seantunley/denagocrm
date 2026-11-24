import type { Prisma } from "@prisma/client";
import type { GridColumnDef, GridSort, SortDir } from "./grid";

/**
 * The Contacts list as a grid (W2-04's first consumer): which columns exist, which
 * of them sort and how, and the ONE `where` the list, its count and the selection
 * preview all share.
 *
 * Pure, so the server action and the tests use exactly what the page uses.
 */

export const CONTACTS_GRID_ID = "contacts";

export const CONTACT_COLUMNS: readonly GridColumnDef[] = [
  { id: "customer", label: "Customer", sortable: true, required: true, width: 260, mobile: "primary" },
  { id: "contact", label: "Contact", sortable: true, width: 240, mobile: "field" },
  { id: "relationship", label: "Relationship", width: 220 },
  { id: "owner", label: "Owner", sortable: true, defaultVisible: false, width: 160, mobile: "field" },
  { id: "city", label: "City", sortable: true, defaultVisible: false, width: 140 },
  { id: "vehicles", label: "Vehicles", align: "center", width: 96, mobile: "field" },
  { id: "leads", label: "Leads", align: "center", width: 88, mobile: "field" },
  { id: "added", label: "Added", sortable: true, width: 120 },
];

/** Newest first — what the list has always shown. */
export const CONTACT_DEFAULT_SORT: GridSort = { column: "added", dir: "desc" };

/**
 * Column → orderBy. `gridOrderBy` appends the id tie-breaker. The counts
 * (vehicles, leads) do not sort: the list shows LIVE counts (not deleted, open
 * only) and Prisma's relation-count ordering would count every row, so the
 * order would not match the numbers on screen.
 */
export const CONTACT_SORTS: Record<string, (dir: SortDir) => Prisma.ContactOrderByWithRelationInput[]> = {
  customer: (dir) => [{ firstName: dir }, { lastName: dir }],
  contact: (dir) => [{ email: dir }, { phone: dir }],
  owner: (dir) => [{ owner: { name: dir } }],
  city: (dir) => [{ city: dir }],
  added: (dir) => [{ createdAt: dir }],
};

/**
 * Which contacts the list holds. Built ONLY from the acting workspace, the
 * viewer's access and the search box — sort, page, view, column and selection
 * parameters never reach it, so nothing in the grid can widen what is listed.
 */
export function contactListWhere(input: {
  /** The acting workspace; null = none resolved, which lists nothing. */
  tenantId: string | null;
  /** null = may see every contact in the workspace; [] = none. */
  accessibleIds: string[] | null;
  q?: string | null;
}): Prisma.ContactWhereInput {
  const q = input.q?.trim();
  return {
    AND: [
      input.tenantId === null ? { id: { in: [] } } : { tenantId: input.tenantId },
      ...(input.accessibleIds === null ? [] : [{ id: { in: input.accessibleIds } }]),
      q
        ? {
            OR: [
              { firstName: { contains: q, mode: "insensitive" as const } },
              { lastName: { contains: q, mode: "insensitive" as const } },
              { company: { contains: q, mode: "insensitive" as const } },
              { email: { contains: q, mode: "insensitive" as const } },
              { phone: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {},
    ],
  };
}
