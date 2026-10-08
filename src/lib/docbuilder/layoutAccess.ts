import "server-only";
import { redirect } from "next/navigation";
import { hasPermission, requireAnyPermission, type PermissionUser } from "@/lib/permissions";
import { isTenantOwner } from "@/lib/auth";

/**
 * Who may edit a layout in the one document editor.
 *
 * The old form editor (retired 2026-10-07, #791) edited the seven operational
 * documents under `document_templates.manage`; the document editor is
 * `docbuilder.manage`. Folding one into the other must not take that ability
 * away (#791 review), so for EXACTLY those seven layouts either permission
 * edits — previews, saves, publishes, resets, restores. Nothing else widens:
 * the quote layout, custom templates, renaming/deleting templates and the
 * content library stay `docbuilder.manage`, as before.
 */
export const FORM_EDITOR_KEYS: ReadonlySet<string> = new Set([
  "invoice",
  "agreement",
  "delivery",
  "indemnity",
  "jobcard",
  "service-report",
  "warranty-claim",
]);

export async function canEditLayout(user: PermissionUser, key: string): Promise<boolean> {
  // A customer EMAIL (doceditor/emailDefaults.ts) is what the workspace sends
  // its customers on its own, and was the owner's to change before it moved into
  // this editor (requireTenantOwner) — it stays the owner's.
  if (key.startsWith("email:")) return isTenantOwner();
  if (await hasPermission(user, "docbuilder.manage")) return true;
  return FORM_EDITOR_KEYS.has(key) && (await hasPermission(user, "document_templates.manage"));
}

/** As requirePermission: the signed-in person, or away to "/" when they may not edit this layout. */
export async function requireLayoutEditor(key: string): Promise<PermissionUser> {
  const user = await requireAnyPermission("docbuilder.manage", "document_templates.manage");
  if (!(await canEditLayout(user, key))) redirect("/");
  return user;
}
