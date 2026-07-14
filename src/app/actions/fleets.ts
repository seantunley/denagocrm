"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { requirePermission, requireVehicleAccess } from "@/lib/permissions";

export async function createFleet(formData: FormData) {
  const user = await requirePermission("fleets.manage");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Give the fleet a name");
  const fleet = await prisma.fleet.create({
    data: {
      name,
      type: String(formData.get("type") ?? "").trim() || null,
      contactId: String(formData.get("contactId") ?? "").trim() || null,
      createdById: user.id,
    },
  });
  await logAudit({ action: "fleet.created", summary: `Created fleet "${name}"`, user });
  redirect(`/fleets/${fleet.id}`);
}

export async function updateFleet(id: string, formData: FormData) {
  const user = await requirePermission("fleets.manage");
  await prisma.fleet.update({
    where: { id },
    data: {
      name: String(formData.get("name") ?? "").trim() || "Untitled fleet",
      type: String(formData.get("type") ?? "").trim() || null,
      contactId: String(formData.get("contactId") ?? "").trim() || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
    },
  });
  await logAudit({ action: "fleet.updated", summary: "Updated fleet", user });
  revalidatePath(`/fleets/${id}`);
}

export async function deleteFleet(formData: FormData) {
  const user = await requirePermission("fleets.manage");
  const id = String(formData.get("id") ?? "");
  await prisma.vehicle.updateMany({ where: { fleetId: id }, data: { fleetId: null } });
  await prisma.fleet.update({ where: { id }, data: { deletedAt: new Date() } });
  await logAudit({ action: "fleet.deleted", summary: "Deleted a fleet", user });
  redirect("/fleets");
}

export async function assignVehicleToFleet(fleetId: string, formData: FormData) {
  const vehicleId = String(formData.get("vehicleId") ?? "");
  if (!vehicleId) return;
  await requireVehicleAccess(vehicleId, "fleets.manage");
  await prisma.vehicle.update({ where: { id: vehicleId }, data: { fleetId } });
  revalidatePath(`/fleets/${fleetId}`);
}

export async function removeVehicleFromFleet(vehicleId: string, fleetId: string) {
  await requireVehicleAccess(vehicleId, "fleets.manage");
  await prisma.vehicle.update({ where: { id: vehicleId }, data: { fleetId: null } });
  revalidatePath(`/fleets/${fleetId}`);
}
