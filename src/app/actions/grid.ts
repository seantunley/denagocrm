"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, refuse } from "@/lib/actionResult";
import { actingScopeClass, withActingStaffScope } from "@/lib/actingScope";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getAccessibleContactIds, hasAnyPermission, requireAnyPermission, type PermissionKey } from "@/lib/permissions";
import { putWorkspaceSetting } from "@/lib/settings";
import {
  checkSelectedIds,
  gridPrefsKey,
  normalisePrefs,
  parseSelectionRequest,
  selectionPreviewText,
  type GridColumnDef,
} from "@/lib/grid/grid";
import { CONTACT_COLUMNS, CONTACTS_GRID_ID, contactListWhere } from "@/lib/grid/contactsGrid";

/**
 * The lists that have a configurable grid. A preference can only be saved for a
 * list named here, by someone allowed to open that list, and only in the shape
 * that list's columns allow.
 */
const GRIDS: Record<string, { columns: readonly GridColumnDef[]; path: string; read: PermissionKey[] }> = {
  [CONTACTS_GRID_ID]: { columns: CONTACT_COLUMNS, path: "/contacts", read: ["contacts.view_all", "contacts.view_owned"] },
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
 * There is deliberately no bulk ACTION on contacts yet (none exists that is safe
 * to run unattended); this is the preview every future one must go through.
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
