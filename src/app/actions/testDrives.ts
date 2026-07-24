"use server";

import crypto from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { logAuditStrict } from "@/lib/audit";
import { saveFile } from "@/lib/storage";

const text = (formData: FormData, key: string) => {
  const value = String(formData.get(key) ?? "").trim();
  return value || null;
};

const requiredText = (formData: FormData, key: string, label: string) => {
  const value = text(formData, key);
  if (!value) throw new Error(`${label} is required`);
  return value;
};

const intValue = (formData: FormData, key: string): number | null => {
  const value = text(formData, key);
  if (value == null) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a whole number`);
  return parsed;
};

const percentValue = (formData: FormData, key: string): number | null => {
  const value = intValue(formData, key);
  if (value == null) return null;
  if (value < 0 || value > 100) throw new Error(`${key} must be between 0 and 100`);
  return value;
};

function localDateTime(value: string | null, label: string): Date {
  if (!value) throw new Error(`${label} is required`);
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const parsed = new Date(hasZone ? value : `${value}:00+02:00`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed;
}

function optionalDate(value: string | null, label: string): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00+02:00`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed;
}

async function requireBooking(id: string) {
  const booking = await prisma.testDriveBooking.findFirst({
    where: { id, deletedAt: null },
    include: { demoVehicle: true },
  });
  if (!booking) throw new Error("Test-drive booking not found");
  return booking;
}

async function assertDemoVehicleAvailable(args: {
  demoVehicleId: string | null;
  start: Date;
  end: Date;
  excludeBookingId?: string;
}) {
  if (!args.demoVehicleId) return;
  const vehicle = await prisma.demoVehicle.findFirst({
    where: { id: args.demoVehicleId, deletedAt: null },
  });
  if (!vehicle || vehicle.status !== "active") {
    throw new Error("That demo vehicle is not available");
  }
  const overlap = await prisma.testDriveBooking.findFirst({
    where: {
      id: args.excludeBookingId ? { not: args.excludeBookingId } : undefined,
      demoVehicleId: args.demoVehicleId,
      deletedAt: null,
      status: { in: ["booked", "confirmed", "checked_out"] },
      scheduledStart: { lt: args.end },
      expectedReturnAt: { gt: args.start },
    },
    select: { reference: true },
  });
  if (overlap) throw new Error(`The demo vehicle is already booked on ${overlap.reference}`);
}

export async function createTestDriveBooking(formData: FormData) {
  const user = await requirePermission("activities.manage");
  const contactId = requiredText(formData, "contactId", "Customer");
  const leadId = text(formData, "leadId");
  const demoVehicleId = text(formData, "demoVehicleId");
  const productId = text(formData, "productId");
  const salespersonId = text(formData, "salespersonId") ?? user.id;
  const accompanyingSalespersonId = text(formData, "accompanyingSalespersonId");
  const branch = requiredText(formData, "branch", "Branch");
  const scheduledStart = localDateTime(text(formData, "scheduledStart"), "Start time");
  const expectedReturnAt = localDateTime(text(formData, "expectedReturnAt"), "Expected return");
  if (expectedReturnAt <= scheduledStart) throw new Error("Expected return must be after the start time");

  const [contact, lead, salesperson, demoVehicle, product] = await Promise.all([
    prisma.contact.findFirst({ where: { id: contactId, deletedAt: null } }),
    leadId ? prisma.lead.findFirst({ where: { id: leadId, deletedAt: null } }) : null,
    prisma.user.findUnique({ where: { id: salespersonId } }),
    demoVehicleId ? prisma.demoVehicle.findFirst({ where: { id: demoVehicleId, deletedAt: null } }) : null,
    productId ? prisma.product.findFirst({ where: { id: productId, deletedAt: null } }) : null,
  ]);
  if (!contact) throw new Error("Customer not found");
  if (leadId && !lead) throw new Error("Lead not found");
  if (lead && lead.contactId && lead.contactId !== contactId) throw new Error("The selected lead belongs to a different customer");
  if (!salesperson) throw new Error("Salesperson not found");
  if (demoVehicleId && !demoVehicle) throw new Error("Demo vehicle not found");
  if (productId && !product) throw new Error("Product not found");
  await assertDemoVehicleAvailable({ demoVehicleId, start: scheduledStart, end: expectedReturnAt });

  const resolvedProductId = productId ?? demoVehicle?.productId ?? lead?.productId ?? null;
  const modelName = product?.name ?? demoVehicle?.name ?? lead?.title ?? "Vehicle";

  const booking = await prisma.$transaction(async (tx) => {
    const activity = await tx.activity.create({
      data: {
        type: "test_drive",
        summary: `Test drive — ${modelName}`,
        note: "Managed from the dedicated Test drives module.",
        location: branch,
        dueDate: scheduledStart,
        status: "planned",
        leadId,
        contactId,
        assignedToId: salespersonId,
        createdById: user.id,
      },
    });

    const mirrored = await tx.testDriveBooking.findUnique({ where: { activityId: activity.id } });
    if (!mirrored) throw new Error("The test-drive calendar bridge did not create the booking");

    return tx.testDriveBooking.update({
      where: { id: mirrored.id },
      data: {
        status: "booked",
        leadId,
        contactId,
        branch,
        demoVehicleId,
        productId: resolvedProductId,
        salespersonId,
        accompanyingSalespersonId,
        scheduledStart,
        expectedReturnAt,
      },
    });
  });

  await logAuditStrict({
    action: "test_drive.created",
    summary: `Booked test drive ${booking.reference}`,
    entityType: "TestDriveBooking",
    entityId: booking.id,
    contactId,
    leadId,
    user,
    after: booking,
  });
  revalidatePath("/test-drives");
  revalidatePath("/calendar");
  redirect(`/test-drives/${booking.id}`);
}

export async function updateTestDriveBooking(id: string, formData: FormData) {
  const user = await requirePermission("activities.manage");
  const before = await requireBooking(id);
  if (["completed", "cancelled", "no_show"].includes(before.status)) {
    throw new Error("Closed test drives cannot be rescheduled");
  }
  const branch = requiredText(formData, "branch", "Branch");
  const demoVehicleId = text(formData, "demoVehicleId");
  const salespersonId = requiredText(formData, "salespersonId", "Salesperson");
  const accompanyingSalespersonId = text(formData, "accompanyingSalespersonId");
  const scheduledStart = localDateTime(text(formData, "scheduledStart"), "Start time");
  const expectedReturnAt = localDateTime(text(formData, "expectedReturnAt"), "Expected return");
  if (expectedReturnAt <= scheduledStart) throw new Error("Expected return must be after the start time");
  await assertDemoVehicleAvailable({ demoVehicleId, start: scheduledStart, end: expectedReturnAt, excludeBookingId: id });

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.testDriveBooking.update({
      where: { id },
      data: { branch, demoVehicleId, salespersonId, accompanyingSalespersonId, scheduledStart, expectedReturnAt },
    });
    if (before.activityId) {
      await tx.activity.update({
        where: { id: before.activityId },
        data: { location: branch, dueDate: scheduledStart, assignedToId: salespersonId },
      });
    }
    return result;
  });
  await logAuditStrict({
    action: "test_drive.updated",
    summary: `Updated test drive ${updated.reference}`,
    entityType: "TestDriveBooking",
    entityId: id,
    contactId: updated.contactId,
    leadId: updated.leadId,
    user,
    before,
    after: updated,
  });
  revalidatePath("/test-drives");
  revalidatePath(`/test-drives/${id}`);
  revalidatePath("/calendar");
}

export async function confirmTestDrive(id: string) {
  const user = await requirePermission("activities.manage");
  const before = await requireBooking(id);
  if (before.status !== "booked") throw new Error("Only booked test drives can be confirmed");
  const updated = await prisma.testDriveBooking.update({ where: { id }, data: { status: "confirmed" } });
  await logAuditStrict({ action: "test_drive.confirmed", summary: `Confirmed ${updated.reference}`, entityType: "TestDriveBooking", entityId: id, contactId: updated.contactId, leadId: updated.leadId, user, before, after: updated });
  revalidatePath("/test-drives");
  revalidatePath(`/test-drives/${id}`);
}

export async function saveDriverControls(id: string, formData: FormData) {
  const user = await requirePermission("activities.manage");
  const before = await requireBooking(id);
  const indemnityStatus = requiredText(formData, "indemnityStatus", "Indemnity status");
  if (!["pending", "signed", "waived", "not_required"].includes(indemnityStatus)) throw new Error("Invalid indemnity status");
  const verified = formData.get("identityVerified") === "on";
  const updated = await prisma.testDriveBooking.update({
    where: { id },
    data: {
      driverLicenceNumber: text(formData, "driverLicenceNumber"),
      driverLicenceExpiry: optionalDate(text(formData, "driverLicenceExpiry"), "Licence expiry"),
      identityVerifiedAt: verified ? before.identityVerifiedAt ?? new Date() : null,
      identityVerifiedById: verified ? user.id : null,
      indemnityStatus,
      emergencyContactName: text(formData, "emergencyContactName"),
      emergencyContactPhone: text(formData, "emergencyContactPhone"),
    },
  });
  await logAuditStrict({ action: "test_drive.driver_controls_updated", summary: `Updated driver controls for ${updated.reference}`, entityType: "TestDriveBooking", entityId: id, contactId: updated.contactId, leadId: updated.leadId, user, before, after: updated });
  revalidatePath(`/test-drives/${id}`);
}

export async function checkOutTestDrive(id: string, formData: FormData) {
  const user = await requirePermission("activities.manage");
  const before = await requireBooking(id);
  if (!["booked", "confirmed"].includes(before.status)) throw new Error("This test drive cannot be checked out");
  if (!before.demoVehicleId) throw new Error("Assign a demo vehicle before check-out");
  if (before.indemnityStatus === "pending") throw new Error("Complete or waive the indemnity before check-out");
  const startOdometerKm = intValue(formData, "startOdometerKm");
  const startBatteryPct = percentValue(formData, "startBatteryPct");
  if (startOdometerKm == null) throw new Error("Start odometer is required");
  if (before.demoVehicle && startOdometerKm < before.demoVehicle.odometerKm) throw new Error("Start odometer cannot be lower than the demo vehicle odometer");

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.testDriveBooking.update({
      where: { id },
      data: {
        status: "checked_out",
        actualStartAt: new Date(),
        startOdometerKm,
        startBatteryPct,
        existingDamage: text(formData, "existingDamage"),
        accessoriesSupplied: text(formData, "accessoriesSupplied"),
        intendedRoute: text(formData, "intendedRoute"),
      },
    });
    await tx.demoVehicle.update({
      where: { id: before.demoVehicleId! },
      data: { odometerKm: startOdometerKm, batteryLevelPct: startBatteryPct },
    });
    return result;
  });
  await logAuditStrict({ action: "test_drive.checked_out", summary: `Checked out ${updated.reference}`, entityType: "TestDriveBooking", entityId: id, contactId: updated.contactId, leadId: updated.leadId, user, before, after: updated });
  revalidatePath("/test-drives");
  revalidatePath("/test-drives/demo-fleet");
  revalidatePath(`/test-drives/${id}`);
}

export async function completeTestDrive(id: string, formData: FormData) {
  const user = await requirePermission("activities.manage");
  const before = await requireBooking(id);
  if (before.status !== "checked_out") throw new Error("Only a checked-out test drive can be completed");
  const returnOdometerKm = intValue(formData, "returnOdometerKm");
  const returnBatteryPct = percentValue(formData, "returnBatteryPct");
  if (returnOdometerKm == null) throw new Error("Return odometer is required");
  if (before.startOdometerKm != null && returnOdometerKm < before.startOdometerKm) throw new Error("Return odometer cannot be lower than the start odometer");
  const salesOutcome = text(formData, "salesOutcome") ?? "undecided";
  if (!["follow_up", "quote_created", "sale_won", "no_interest", "undecided"].includes(salesOutcome)) throw new Error("Invalid sales outcome");
  const convertedQuoteId = text(formData, "convertedQuoteId");
  if (convertedQuoteId) {
    const quote = await prisma.quote.findFirst({ where: { id: convertedQuoteId, deletedAt: null } });
    if (!quote || (quote.contactId && quote.contactId !== before.contactId)) throw new Error("The selected quote is not available for this customer");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.testDriveBooking.update({
      where: { id },
      data: {
        status: "completed",
        actualReturnAt: new Date(),
        returnOdometerKm,
        returnBatteryPct,
        returnCondition: text(formData, "returnCondition"),
        newDamage: text(formData, "newDamage"),
        incidentReport: text(formData, "incidentReport"),
        cleaningRequired: formData.get("cleaningRequired") === "on",
        chargingRequired: formData.get("chargingRequired") === "on",
        customerFeedback: text(formData, "customerFeedback"),
        salesOutcome,
        convertedQuoteId,
      },
    });
    if (before.demoVehicleId) {
      await tx.demoVehicle.update({
        where: { id: before.demoVehicleId },
        data: { odometerKm: returnOdometerKm, batteryLevelPct: returnBatteryPct },
      });
    }
    if (before.activityId) {
      await tx.activity.update({ where: { id: before.activityId }, data: { status: "done", doneAt: new Date() } });
    }
    return result;
  });
  await logAuditStrict({ action: "test_drive.completed", summary: `Completed ${updated.reference}`, entityType: "TestDriveBooking", entityId: id, contactId: updated.contactId, leadId: updated.leadId, user, before, after: updated });
  revalidatePath("/test-drives");
  revalidatePath("/test-drives/demo-fleet");
  revalidatePath(`/test-drives/${id}`);
  revalidatePath("/calendar");
}

export async function cancelTestDrive(id: string, formData: FormData) {
  const user = await requirePermission("activities.manage");
  const before = await requireBooking(id);
  if (["completed", "cancelled", "no_show"].includes(before.status)) throw new Error("This test drive is already closed");
  const reason = requiredText(formData, "reason", "Cancellation reason");
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.testDriveBooking.update({ where: { id }, data: { status: "cancelled", cancellationReason: reason } });
    if (before.activityId) await tx.activity.update({ where: { id: before.activityId }, data: { status: "canceled" } });
    return result;
  });
  await logAuditStrict({ action: "test_drive.cancelled", summary: `Cancelled ${updated.reference}`, entityType: "TestDriveBooking", entityId: id, contactId: updated.contactId, leadId: updated.leadId, user, before, after: updated });
  revalidatePath("/test-drives");
  revalidatePath(`/test-drives/${id}`);
  revalidatePath("/calendar");
}

export async function markTestDriveNoShow(id: string, formData: FormData) {
  const user = await requirePermission("activities.manage");
  const before = await requireBooking(id);
  if (!["booked", "confirmed"].includes(before.status)) throw new Error("Only an upcoming test drive can be marked no-show");
  const reason = text(formData, "reason");
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.testDriveBooking.update({ where: { id }, data: { status: "no_show", noShowReason: reason } });
    if (before.activityId) await tx.activity.update({ where: { id: before.activityId }, data: { status: "canceled" } });
    return result;
  });
  await logAuditStrict({ action: "test_drive.no_show", summary: `Marked ${updated.reference} as no-show`, entityType: "TestDriveBooking", entityId: id, contactId: updated.contactId, leadId: updated.leadId, user, before, after: updated });
  revalidatePath("/test-drives");
  revalidatePath(`/test-drives/${id}`);
  revalidatePath("/calendar");
}

export async function createDemoVehicle(formData: FormData) {
  const user = await requirePermission("vehicles.manage");
  const name = requiredText(formData, "name", "Display name");
  const productId = text(formData, "productId");
  const stockUnitId = text(formData, "stockUnitId");
  if (stockUnitId) {
    const existing = await prisma.demoVehicle.findFirst({ where: { stockUnitId, deletedAt: null } });
    if (existing) throw new Error("That stock unit is already in the demo fleet");
  }
  const demo = await prisma.demoVehicle.create({
    data: {
      name,
      productId,
      stockUnitId,
      vin: text(formData, "vin"),
      regNumber: text(formData, "regNumber"),
      color: text(formData, "color"),
      branch: text(formData, "branch"),
      odometerKm: intValue(formData, "odometerKm") ?? 0,
      batteryLevelPct: percentValue(formData, "batteryLevelPct"),
      notes: text(formData, "notes"),
    },
  });
  await logAuditStrict({ action: "demo_vehicle.created", summary: `Added demo vehicle ${demo.name}`, entityType: "DemoVehicle", entityId: demo.id, user, after: demo });
  revalidatePath("/test-drives");
  revalidatePath("/test-drives/demo-fleet");
}

export async function updateDemoVehicle(id: string, formData: FormData) {
  const user = await requirePermission("vehicles.manage");
  const before = await prisma.demoVehicle.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw new Error("Demo vehicle not found");
  const status = requiredText(formData, "status", "Status");
  if (!["active", "maintenance", "unavailable", "retired"].includes(status)) throw new Error("Invalid demo vehicle status");
  const updated = await prisma.demoVehicle.update({
    where: { id },
    data: {
      name: requiredText(formData, "name", "Display name"),
      branch: text(formData, "branch"),
      regNumber: text(formData, "regNumber"),
      color: text(formData, "color"),
      status,
      odometerKm: intValue(formData, "odometerKm") ?? before.odometerKm,
      batteryLevelPct: percentValue(formData, "batteryLevelPct"),
      notes: text(formData, "notes"),
    },
  });
  await logAuditStrict({ action: "demo_vehicle.updated", summary: `Updated demo vehicle ${updated.name}`, entityType: "DemoVehicle", entityId: id, user, before, after: updated });
  revalidatePath("/test-drives");
  revalidatePath("/test-drives/demo-fleet");
}

const ALLOWED_ASSET_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const ALLOWED_ASSET_KINDS = new Set(["driver_licence", "start_condition", "return_condition", "incident", "other"]);

export async function uploadTestDriveAsset(id: string, kind: string, formData: FormData) {
  const user = await requirePermission("activities.manage");
  const booking = await requireBooking(id);
  if (!ALLOWED_ASSET_KINDS.has(kind)) throw new Error("Invalid asset type");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) throw new Error("Choose a file to upload");
  if (file.size > 10 * 1024 * 1024) throw new Error("Files must be 10 MB or smaller");
  if (!ALLOWED_ASSET_TYPES.has(file.type)) throw new Error("Use PDF, JPG, PNG or WebP files");
  const storedName = await saveFile(Buffer.from(await file.arrayBuffer()), file.name, file.type);
  const asset = await prisma.testDriveAsset.create({
    data: {
      bookingId: id,
      kind,
      fileName: file.name,
      storedName,
      mimeType: file.type,
      sizeBytes: file.size,
      note: text(formData, "note"),
      uploadedById: user.id,
    },
  });
  await logAuditStrict({ action: "test_drive.asset_uploaded", summary: `Uploaded ${kind.replaceAll("_", " ")} for ${booking.reference}`, entityType: "TestDriveAsset", entityId: asset.id, contactId: booking.contactId, leadId: booking.leadId, user, after: asset });
  revalidatePath(`/test-drives/${id}`);
}

export function newTestDriveReference() {
  return `TD-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}
