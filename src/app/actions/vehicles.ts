"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { sendReviewRequest } from "@/lib/reviewRequests";
import { triggerSurvey } from "@/lib/surveys";
import { remindVehicleService } from "@/lib/serviceReminders";
import { softDeleteRecord } from "@/lib/trash";
import { isModuleEnabled } from "@/lib/modules/enabled";
import {
  requireContactAccess,
  requireVehicleAccess,
} from "@/lib/permissions";

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
  // The automotive pack owns vehicles; a stale quick-create dialog could still POST
  // this action after the pack is switched off, so reject it server-side.
  if (!(await isModuleEnabled("automotive"))) {
    throw new Error("The automotive module is disabled");
  }
  const data = vehicleData(formData);
  if (!data.contactId) throw new Error("Customer is required");
  const user = await requireContactAccess(data.contactId, "vehicles.manage");
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
  if (formData.get("newDelivery")) {
    await sendReviewRequest(vehicle.contactId, "delivery", vehicle.model).catch(() => {});
    await triggerSurvey("delivery", { contactId: vehicle.contactId });
  }
  revalidatePath("/vehicles");
  redirect(`/vehicles/${vehicle.id}`);
}

export async function addBatteryCheck(vehicleId: string, formData: FormData) {
  const user = await requireVehicleAccess(vehicleId, "vehicles.manage");
  const num = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    if (v === "") return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  };
  const soh = num("stateOfHealth");
  const cycles = num("cycles");
  const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
  await prisma.batteryCheck.create({
    data: {
      vehicleId,
      packSerial: String(formData.get("packSerial") ?? "").trim() || null,
      stateOfHealth: soh != null ? Math.max(0, Math.min(100, Math.round(soh))) : null,
      voltage: num("voltage"),
      cycles: cycles != null ? Math.max(0, Math.round(cycles)) : null,
      notes: String(formData.get("notes") ?? "").trim() || null,
      recordedById: user.id,
    },
  });
  await logAudit({
    action: "battery.checked",
    summary: `Logged a battery check on ${vehicle.model}${soh != null ? ` (${Math.round(soh)}% SoH)` : ""}`,
    user,
  });
  revalidatePath(`/vehicles/${vehicleId}`);
}

export async function deleteBatteryCheck(id: string) {
  const bc = await prisma.batteryCheck.findUnique({ where: { id } });
  if (!bc) return;
  await requireVehicleAccess(bc.vehicleId, "vehicles.manage");
  await prisma.batteryCheck.delete({ where: { id } });
  revalidatePath(`/vehicles/${bc.vehicleId}`);
}

export type RemindResult = { ok: boolean; channel?: string; error?: string } | null;

export async function remindService(_prev: RemindResult, formData: FormData): Promise<RemindResult> {
  const vehicleId = String(formData.get("vehicleId") ?? "");
  await requireVehicleAccess(vehicleId, "vehicles.manage");
  const res = await remindVehicleService(vehicleId);
  revalidatePath("/service-due");
  return res;
}

export async function updateVehicle(id: string, formData: FormData) {
  await requireVehicleAccess(id, "vehicles.manage");
  const data = vehicleData(formData);
  if (!data.model) throw new Error("Model is required");
  // #15: reassigning the vehicle to a DIFFERENT contact requires access to that
  // destination contact too — authorizing only the vehicle would let a user move
  // it onto a customer they can't otherwise access.
  const current = await prisma.vehicle.findUnique({ where: { id }, select: { contactId: true } });
  if (current && data.contactId && data.contactId !== current.contactId) {
    await requireContactAccess(data.contactId, "vehicles.manage");
  }
  await prisma.vehicle.update({ where: { id }, data });
  revalidatePath("/vehicles");
  revalidatePath(`/vehicles/${id}`);
  redirect(`/vehicles/${id}`);
}

export async function deleteVehicle(id: string, formData: FormData) {
  const user = await requireVehicleAccess(id, "vehicles.manage");
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
  await requireVehicleAccess(vehicleId, "vehicles.manage");
  const km = parseInt(String(formData.get("km") ?? ""), 10);
  if (isNaN(km) || km < 0) return;
  const note = String(formData.get("note") ?? "").trim() || null;
  await prisma.mileageLog.create({ data: { vehicleId, km, note } });
  revalidatePath(`/vehicles/${vehicleId}`);
  revalidatePath("/vehicles");
}

export async function deleteMileage(id: string, vehicleId: string, formData: FormData) {
  const user = await requireVehicleAccess(vehicleId, "vehicles.manage");
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  // Scope to the authorized vehicle — don't delete another vehicle's entry by id.
  const owned = await prisma.mileageLog.findFirst({ where: { id, vehicleId } });
  if (!owned) return;
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
  const user = await requireVehicleAccess(vehicleId, "vehicles.manage");
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
  const user = await requireVehicleAccess(vehicleId, "vehicles.manage");
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  // Scope to the authorized vehicle — don't delete another vehicle's record by id.
  const owned = await prisma.serviceRecord.findFirst({ where: { id, vehicleId } });
  if (!owned) return;
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
