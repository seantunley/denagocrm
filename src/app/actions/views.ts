"use server";

import { asActionResult, refuse } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireAnyPermission } from "@/lib/permissions";

/**
 * Saved views are shared list presets, and every caller today is the leads list
 * (/leads/list). Gate on the same read grant that page requires — the legacy
 * `requireCrm()` here was the per-user module CSV, an authorization source RBAC
 * never wrote to.
 */
const requireViews = () => requireAnyPermission("leads.view_all", "leads.view_owned");

export async function saveView(formData: FormData) {
  return asActionResult(async () => {
    await requireViews();
    const name = String(formData.get("name") ?? "").trim();
    const page = String(formData.get("page") ?? "").trim();
    const query = String(formData.get("query") ?? "").trim();
    if (!name || !page) refuse("Give the view a name.");
    await prisma.savedView.create({ data: { name, page, query } });
    revalidatePath(`/${page}/list`);
  });
}

export async function deleteView(id: string, formData: FormData) {
  return asActionResult(async () => {
    await requireViews();
    void formData;
    const view = await prisma.savedView.delete({ where: { id } });
    revalidatePath(`/${view.page}/list`);
  });
}
