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

// ── Service packages ──────────────────────────────────────────────────────────
export async function savePackage(formData: FormData) {
  await requirePermission("workshop.manage");
  const id = String(formData.get("id") ?? "").trim() || null;
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("A package needs a name");
  const description = String(formData.get("description") ?? "").trim() || null;
  const active = formData.get("active") === "on";
  if (id) await prisma.servicePackage.update({ where: { id }, data: { name, description, active } });
  else await prisma.servicePackage.create({ data: { name, description, active } });
  revalidatePath("/settings/workshop");
  revalidatePath("/jobcards");
}

export async function deletePackage(id: string) {
  await requirePermission("workshop.manage");
  await prisma.servicePackage.delete({ where: { id } }).catch(() => {});
  revalidatePath("/settings/workshop");
}

export async function addPackageItem(packageId: string, formData: FormData) {
  await requirePermission("workshop.manage");
  const description = String(formData.get("description") ?? "").trim();
  if (!description) return;
  const kind = String(formData.get("kind") ?? "part") === "labour" ? "labour" : "part";
  const qty = parseFloat(String(formData.get("qty") ?? "1")) || 1;
  const unitPriceCents = parseRands(String(formData.get("unitPrice") ?? ""));
  await prisma.servicePackageItem.create({ data: { packageId, kind, description, qty, unitPriceCents } });
  revalidatePath("/settings/workshop");
}

export async function deletePackageItem(id: string) {
  await requirePermission("workshop.manage");
  await prisma.servicePackageItem.delete({ where: { id } }).catch(() => {});
  revalidatePath("/settings/workshop");
}
