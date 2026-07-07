"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { sendReviewRequest } from "@/lib/reviewRequests";
import { softDeleteRecord } from "@/lib/trash";

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
  const user = await requireUser();
  const data = vehicleData(formData);
  if (!data.contactId) throw new Error("Customer is required");
  if (!data.model && data.productId) {
    const p = await prisma.product.findUnique({ where: { id: data.productId } });
    data.model = p?.name ?? "";
  }
  if (!data.model) throw new Error("Model is required");

  const vehicle = await prisma.vehicle.create({ data });
  await logAudit({
    action: "vehicle.registered",
    summary: `Registered vehicle ${vehicle.model}${vehicle.color ? ` (${vehicle.color})` : ""}`,
    contactId: vehicle.contactId,
    user,
  });

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
  // New-cart delivery → ask for a Google review (only when ticked on the form)
  if (formData.get("newDelivery")) {
    await sendReviewRequest(vehicle.contactId, "delivery", vehicle.model).catch(() => {});
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

export async function deleteVehicle(id: string, formData: FormData) {
  const user = await requireUser();
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const vehicle = await softDeleteRecord("vehicle", id, reason, user.name);
  await logAudit({
    action: "trash.deleted",
    summary: `Moved vehicle ${vehicle.model} to trash — ${reason}`,
    contactId: vehicle.contactId,
    user,
  });
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

export async function deleteMileage(id: string, vehicleId: string, formData: FormData) {
  const user = await requireUser();
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const entry = await prisma.mileageLog.delete({ where: { id } });
  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
  await logAudit({
    action: "vehicle.mileage_deleted",
    summary: `Deleted mileage entry ${entry.km.toLocaleString()} km on ${vehicle?.model ?? "vehicle"} — ${reason}`,
    contactId: vehicle?.contactId,
    user,
  });
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
  const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
  await logAudit({
    action: "service.recorded",
    summary: `Recorded service on ${vehicle.model}: ${summary}`,
    contactId: vehicle.contactId,
    user,
  });
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

export async function deleteServiceRecord(id: string, vehicleId: string, formData: FormData) {
  const user = await requireUser();
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const record = await prisma.serviceRecord.delete({ where: { id } });
  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
  await logAudit({
    action: "service.deleted",
    summary: `Deleted service record “${record.summary}” on ${vehicle?.model ?? "vehicle"} — ${reason}`,
    contactId: vehicle?.contactId,
    user,
  });
  revalidatePath(`/vehicles/${vehicleId}`);
}
