"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, refuse } from "@/lib/actionResult";
import { actingScopeClass, withActingStaffScope, withActingTenantWrite } from "@/lib/actingScope";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import {
  getAccessibleContactIds,
  hasAnyPermission,
  requireAnyPermission,
  requirePermission,
  type PermissionKey,
} from "@/lib/permissions";
import { putWorkspaceSetting } from "@/lib/settings";
import {
  MAX_BULK_ROWS,
  bulkResultText,
  checkSelectedIds,
  gridPrefsKey,
  normalisePrefs,
  parseSelectionRequest,
  selectionPreviewText,
  type GridColumnDef,
} from "@/lib/grid/grid";
import { CONTACT_COLUMNS, CONTACTS_GRID_ID, contactListWhere } from "@/lib/grid/contactsGrid";
import { QUOTE_COLUMNS, QUOTES_GRID_ID } from "@/lib/grid/quotesGrid";
import { STOCK_COLUMNS, STOCK_GRID_ID } from "@/lib/grid/stockGrid";

/**
 * The lists that have a configurable grid. A preference can only be saved for a
 * list named here, by someone allowed to open that list, and only in the shape
 * that list's columns allow.
 */
const GRIDS: Record<string, { columns: readonly GridColumnDef[]; path: string; read: PermissionKey[] }> = {
  [CONTACTS_GRID_ID]: { columns: CONTACT_COLUMNS, path: "/contacts", read: ["contacts.view_all", "contacts.view_owned"] },
  [QUOTES_GRID_ID]: { columns: QUOTE_COLUMNS, path: "/quotes", read: ["quotes.view_all", "quotes.view_owned"] },
  [STOCK_GRID_ID]: { columns: STOCK_COLUMNS, path: "/stock", read: ["stock.view", "stock.manage"] },
};

async function actingWorkspace(): Promise<string> {
  const scope = await actingScopeClass();
  if (scope.mode !== "tenant") refuse("Your session could not be matched to a workspace. Sign in again.");
  return scope.tenantId;
}

/**
 * Save (or, with `null`, reset) the caller's OWN layout for one list: column
 * order, visibility, widths and density. Theirs alone — keyed by their id — and
 * kept in THIS workspace. Changes how the list looks to them; never what it holds.
 */
export async function saveGridPrefs(gridId: string, prefs: unknown) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      // Signed in first, so an unknown list id tells an outsider nothing.
      const user = await requireUser();
      const grid = Object.hasOwn(GRIDS, gridId) ? GRIDS[gridId] : undefined;
      if (!grid || !(await hasAnyPermission(user, ...grid.read))) refuse("You can't change the layout of that list.");
      const tenantId = await actingWorkspace();
      const key = gridPrefsKey(gridId, user.id);
      // Empty = no row value = defaults on the next read.
      await putWorkspaceSetting(tenantId, key, prefs === null ? "" : JSON.stringify(normalisePrefs(prefs, grid.columns)));
      revalidatePath(grid.path);
      return { success: prefs === null ? "Layout reset" : "Layout saved" };
    }),
  );
}

/**
 * What a bulk action on the ticked contacts WOULD touch — re-checked here, row by
 * row, against the caller's access right now. The browser's list is never
 * trusted: ids it sends are intersected with the workspace and the caller's
 * access, and "all matching" is recounted from the search alone.
 *
 * Every bulk action on contacts (bulkTagContacts below) goes through the same
 * check again when it runs — a preview is a promise about nothing.
 */
export async function previewContactSelection(raw: unknown) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requireAnyPermission("contacts.view_all", "contacts.view_owned");
      const request = parseSelectionRequest(raw);
      if (!request) refuse("Tick up to 500 contacts, or use Select all.");
      const tenantId = await actingWorkspace();
      const accessibleIds = await getAccessibleContactIds(user);
      const noun = { one: "contact", many: "contacts" };

      if (request.mode === "all") {
        const allowed = await prisma.contact.count({ where: contactListWhere({ tenantId, accessibleIds, q: request.q }) });
        return { success: selectionPreviewText(noun, { allowed, refused: 0, shownTotal: request.shownTotal }) };
      }

      const found = await prisma.contact.findMany({
        where: { AND: [contactListWhere({ tenantId, accessibleIds }), { id: { in: request.ids } }] },
        select: { id: true },
      });
      const { allowed, refused } = checkSelectedIds(request.ids, found.map((row) => row.id));
      return { success: selectionPreviewText(noun, { allowed: allowed.length, refused }) };
    }),
  );
}

/**
 * Bulk "Add tag" on the ticked contacts — the one bulk action the grid runs.
 *
 * Adding an EXISTING tag is the safest change a contact has: it only adds a
 * link (nothing is overwritten or removed), it is undone by editing the contact,
 * and the tag must already exist in this workspace — no tag is created here.
 *
 * Every row is checked again, here, on the server — the same rule as editing one
 * contact (updateContact → requireContactAccess(id, "contacts.edit")): the
 * permission, then the contact in THIS workspace and in the caller's access.
 * Ids the browser sent that fail it are counted and skipped, never named.
 * "All matching" is rebuilt from the search alone, and refused if the list has
 * changed since the person chose it, so nothing they did not see is touched.
 */
export async function bulkTagContacts(raw: unknown, tagId: unknown) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requirePermission("contacts.edit");
      const request = parseSelectionRequest(raw);
      if (!request) refuse("Tick up to 500 contacts, or use Select all.");
      if (typeof tagId !== "string" || !tagId) refuse("Choose a tag.");
      const tenantId = await actingWorkspace();
      const tag = await prisma.tag.findFirst({ where: { id: tagId, tenantId }, select: { id: true, name: true } });
      if (!tag) refuse("That tag no longer exists. Refresh and choose another.");
      const accessibleIds = await getAccessibleContactIds(user);

      let allowed: string[];
      let refused = 0;
      if (request.mode === "all") {
        // Built from the same scope as the list, so every id here is already in access.
        const where = contactListWhere({ tenantId, accessibleIds, q: request.q });
        const total = await prisma.contact.count({ where });
        if (total !== request.shownTotal) refuse("The list has changed since you selected it. Preview again.");
        if (total > MAX_BULK_ROWS) refuse(`That's more than ${MAX_BULK_ROWS.toLocaleString("en")} contacts. Narrow the search and try again.`);
        allowed = (await prisma.contact.findMany({ where, select: { id: true } })).map((row) => row.id);
      } else {
        const found = await prisma.contact.findMany({
          where: { AND: [contactListWhere({ tenantId, accessibleIds }), { id: { in: request.ids } }] },
          select: { id: true },
        });
        ({ allowed, refused } = checkSelectedIds(request.ids, found.map((row) => row.id)));
      }

      // One transaction: every allowed contact gets the tag, or (on an error) none
      // does. The join table has no tenant column, so BOTH ends were proved to be
      // in this workspace above — the same rule as the journey "Add tag" step.
      const tagged = await withActingTenantWrite(async (tx) => {
        const added: string[] = [];
        for (const contactId of allowed) {
          const inserted: number = await tx.$executeRaw`INSERT INTO "_ContactToTag" ("A","B") VALUES (${contactId},${tag.id}) ON CONFLICT DO NOTHING`;
          if (inserted > 0) added.push(contactId);
        }
        return added;
      });
      for (const contactId of tagged) {
        await logAudit({ action: "contact.tagged", summary: `Added tag “${tag.name}” (bulk)`, contactId, user });
      }
      revalidatePath("/contacts");
      return {
        success: bulkResultText(
          { one: "contact", many: "contacts" },
          { done: "tagged", unchanged: "already had it" },
          { done: tagged.length, unchanged: allowed.length - tagged.length, refused },
        ),
      };
    }),
  );
}
