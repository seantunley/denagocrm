"use server";


import { asActionResult, ActionRefusal, refuse } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { getRegionalSettings, putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { formatZAR } from "@/lib/format";
import { parseMoneyField } from "@/lib/moneyInput";
import { LABOUR_RATE_SETTING } from "@/lib/workshop";

export async function saveDefaultLabourRate(formData: FormData) {
  return asActionResult(async () => {
    const user = await requirePermission("workshop.manage");
    // Read and shown in the workspace's currency, strictly (moneyInput.ts).
    const regional = await getRegionalSettings();
    const rate = parseMoneyField(String(formData.get("labourRate") ?? ""), regional.currency);
    if (!rate.ok) refuse(`Labour rate: ${rate.error}`);
    const cents = rate.cents ?? 0;
    await putSetting(LABOUR_RATE_SETTING, String(cents));
    await logAudit({ action: "workshop.labour_rate", summary: `Default workshop labour rate set to ${formatZAR(cents, regional)}/hour`, user });
    revalidatePath("/settings/workshop");
  });
}

export async function saveBay(formData: FormData) {
  return asActionResult(async () => {
    const user = await requirePermission("workshop.manage");
    const id = String(formData.get("id") ?? "").trim() || null;
    const name = String(formData.get("name") ?? "").trim();
    if (name.length < 1) throw new ActionRefusal("A bay needs a name");
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
  });
}

/**
 * `.catch(() => …)` used to swallow EVERY delete failure alike, so a bay still
 * in use by a job card reported the same as one that was removed. Only "the row
 * is already gone" is benign; a constraint violation has to be said out loud.
 */
function rethrowDeleteFailure(error: unknown, inUse: string): never | undefined {
  const code = (error as { code?: string })?.code;
  if (code === "P2025") return undefined; // already deleted — the caller's goal is met
  if (code === "P2003" || code === "P2014") refuse(inUse);
  throw error;
}

export async function deleteBay(id: string) {
  return asActionResult(async () => {
    const user = await requirePermission("workshop.manage");
    const bay = await prisma.workshopBay
      .delete({ where: { id } })
      .catch((error) => rethrowDeleteFailure(error, "That bay is still in use — reassign its job cards first.") ?? null);
    if (bay) await logAudit({ action: "workshop.bay_deleted", summary: `Deleted workshop bay “${bay.name}”`, user });
    revalidatePath("/settings/workshop");
  });
}

// ── Service packages ──────────────────────────────────────────────────────────
export async function savePackage(formData: FormData) {
  return asActionResult(async () => {
    await requirePermission("workshop.manage");
    const id = String(formData.get("id") ?? "").trim() || null;
    const name = String(formData.get("name") ?? "").trim();
    if (!name) throw new ActionRefusal("A package needs a name");
    const description = String(formData.get("description") ?? "").trim() || null;
    const active = formData.get("active") === "on";
    if (id) await prisma.servicePackage.update({ where: { id }, data: { name, description, active } });
    else await prisma.servicePackage.create({ data: { name, description, active } });
    revalidatePath("/settings/workshop");
    revalidatePath("/jobcards");
  });
}

export async function deletePackage(id: string) {
  return asActionResult(async () => {
    await requirePermission("workshop.manage");
    await prisma.servicePackage
      .delete({ where: { id } })
      .catch((error) => rethrowDeleteFailure(error, "That package is still in use — remove it from its job cards first."));
    revalidatePath("/settings/workshop");
  });
}

export async function addPackageItem(packageId: string, formData: FormData) {
  return asActionResult(async () => {
    await requirePermission("workshop.manage");
    const description = String(formData.get("description") ?? "").trim();
    if (!description) refuse("Give the line item a description.");
    const kind = String(formData.get("kind") ?? "part") === "labour" ? "labour" : "part";
    const qty = parseFloat(String(formData.get("qty") ?? "1")) || 1;
    const price = parseMoneyField(String(formData.get("unitPrice") ?? ""), (await getRegionalSettings()).currency);
    if (!price.ok) refuse(`Unit price: ${price.error}`);
    const unitPriceCents = price.cents ?? 0;
    await prisma.servicePackageItem.create({ data: { packageId, kind, description, qty, unitPriceCents } });
    revalidatePath("/settings/workshop");
  });
}

export async function deletePackageItem(id: string) {
  return asActionResult(async () => {
    await requirePermission("workshop.manage");
    await prisma.servicePackageItem
      .delete({ where: { id } })
      .catch((error) => rethrowDeleteFailure(error, "That line item could not be removed."));
    revalidatePath("/settings/workshop");
  });
}
