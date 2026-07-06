"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

function vehicleData(formData: FormData) {
  const str = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  const int = (k: string) => {
    const v = str(k);
    if (v == null) return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  };
  return {
    model: String(formData.get("model") ?? "").trim(),
    vin: str("vin"),
    regNumber: str("regNumber"),
    color: str("color"),
    purchaseDate: str("purchaseDate") ? new Date(String(formData.get("purchaseDate"))) : null,
    warrantyMonths: int("warrantyMonths"),
    serviceIntervalKm: int("serviceIntervalKm"),
    serviceIntervalMonths: int("serviceIntervalMonths"),
    notes: str("notes"),
    contactId: String(formData.get("contactId") ?? ""),
    productId: str("productId"),
  };
}

export async function createVehicle(formData: FormData) {
  await requireUser();
  const data = vehicleData(formData);
  if (!data.contactId) throw new Error("Customer is required");
  if (!data.model && data.productId) {
    const p = await prisma.product.findUnique({ where: { id: data.productId } });
    data.model = p?.name ?? "";
  }
  if (!data.model) throw new Error("Model is required");

  const vehicle = await prisma.vehicle.create({ data });

  const initialKm = String(formData.get("initialKm") ?? "").trim();
  if (initialKm !== "" && !isNaN(parseInt(initialKm, 10))) {
    await prisma.mileageLog.create({
      data: {
        vehicleId: vehicle.id,
        km: parseInt(initialKm, 10),
        note: "Initial reading",
      },
    });
  }
  revalidatePath("/vehicles");
  redirect(`/vehicles/${vehicle.id}`);
}

export async function updateVehicle(id: string, formData: FormData) {
  await requireUser();
  const data = vehicleData(formData);
  if (!data.model) throw new Error("Model is required");
  await prisma.vehicle.update({ where: { id }, data });
  revalidatePath("/vehicles");
  revalidatePath(`/vehicles/${id}`);
  redirect(`/vehicles/${id}`);
}

export async function deleteVehicle(id: string) {
  await requireUser();
  await prisma.vehicle.delete({ where: { id } });
  revalidatePath("/vehicles");
  redirect("/vehicles");
}

export async function addMileage(vehicleId: string, formData: FormData) {
  await requireUser();
  const km = parseInt(String(formData.get("km") ?? ""), 10);
  if (isNaN(km) || km < 0) return;
  const note = String(formData.get("note") ?? "").trim() || null;
  await prisma.mileageLog.create({ data: { vehicleId, km, note } });
  revalidatePath(`/vehicles/${vehicleId}`);
  revalidatePath("/vehicles");
}

export async function deleteMileage(id: string, vehicleId: string) {
  await requireUser();
  await prisma.mileageLog.delete({ where: { id } });
  revalidatePath(`/vehicles/${vehicleId}`);
}

export async function addServiceRecord(vehicleId: string, formData: FormData) {
  const user = await requireUser();
  const str = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  const int = (k: string) => {
    const v = str(k);
    if (v == null) return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  };
  const summary = String(formData.get("summary") ?? "").trim();
  if (!summary) return;

  const km = int("km");
  await prisma.serviceRecord.create({
    data: {
      vehicleId,
      summary,
      details: str("details"),
      serviceDate: str("serviceDate") ? new Date(String(formData.get("serviceDate"))) : new Date(),
      km,
      nextDueKm: int("nextDueKm"),
      nextDueDate: str("nextDueDate") ? new Date(String(formData.get("nextDueDate"))) : null,
      performedById: user.id,
    },
  });
  if (km != null) {
    await prisma.mileageLog.create({
      data: { vehicleId, km, note: "At service" },
    });
  }
  revalidatePath(`/vehicles/${vehicleId}`);
  revalidatePath("/vehicles");
}

export async function deleteServiceRecord(id: string, vehicleId: string) {
  await requireUser();
  await prisma.serviceRecord.delete({ where: { id } });
  revalidatePath(`/vehicles/${vehicleId}`);
}
