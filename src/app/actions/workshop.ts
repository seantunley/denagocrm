"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { parseRands } from "@/lib/format";
import { LABOUR_RATE_SETTING } from "@/lib/workshop";

export async function saveDefaultLabourRate(formData: FormData) {
  const user = await requirePermission("workshop.manage");
  const cents = parseRands(String(formData.get("labourRate") ?? ""));
  await putSetting(LABOUR_RATE_SETTING, String(cents));
  await logAudit({ action: "workshop.labour_rate", summary: `Default workshop labour rate set to R${(cents / 100).toFixed(2)}/hour`, user });
  revalidatePath("/settings/workshop");
}

export async function saveBay(formData: FormData) {
  const user = await requirePermission("workshop.manage");
  const id = String(formData.get("id") ?? "").trim() || null;
  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 1) throw new Error("A bay needs a name");
  const color = String(formData.get("color") ?? "#0ea5e9").trim() || "#0ea5e9";
  const sortOrder = parseInt(String(formData.get("sortOrder") ?? "0"), 10) || 0;
  const active = formData.get("active") === "on";
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (id) {
    await prisma.workshopBay.update({ where: { id }, data: { name, color, sortOrder, active, notes } });
  } else {
    await prisma.workshopBay.create({ data: { name, color, sortOrder, active, notes } });
  }
  await logAudit({ action: "workshop.bay", summary: `${id ? "Updated" : "Created"} workshop bay “${name}”`, user });
  revalidatePath("/settings/workshop");
  revalidatePath("/jobcards");
}

export async function deleteBay(id: string) {
  const user = await requirePermission("workshop.manage");
  const bay = await prisma.workshopBay.delete({ where: { id } }).catch(() => null);
  if (bay) await logAudit({ action: "workshop.bay_deleted", summary: `Deleted workshop bay “${bay.name}”`, user });
  revalidatePath("/settings/workshop");
}
