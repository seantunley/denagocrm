"use server";

import crypto from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { agreedTenantId } from "@/lib/compositeTenantRules";
import { canAccessQuote, requirePermission } from "@/lib/permissions";
import { logAuditStrict } from "@/lib/audit";
import { saveFile } from "@/lib/storage";
// main's imports: `resolveAssignableUser` is the assignment CONTRACT that
// replaced the bare `resolveTenantMemberUser` lookup — it refuses a posted
// assignee who is not a member of the acting workspace instead of returning
// null for the caller to ignore, which is why the refusal helpers come with it.
import { resolveAssignableUser } from "@/lib/tenantActor";
import { actingTenantId } from "@/lib/actingTenant";
import { ActionRefusal } from "@/lib/actionFailure";
import { assignmentRefusalMessage } from "@/lib/assignableUser";
import { withActingStaffScope } from "@/lib/actingScope";
import {
  assertTestDriveCustomerAccess,
  requireTestDriveManageAccess,
} from "@/lib/testDriveAccess";

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

function newReference() {
  return `TD-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

async function requireBooking(id: string) {
  const booking = await prisma.testDriveBooking.findFirst({
    where: { id, deletedAt: null },
    include: { demoVehicle: true },
  });
  if (!booking) throw new Error("Test-drive booking not found");
  return booking;
}

async function auditBooking(args: {
  action: string;
  summary: string;
  user: { id: string; name: string };
  booking: { id: string; contactId: string; leadId: string | null };
  before?: unknown;
  after?: unknown;
}) {
  await logAuditStrict({
    action: args.action,
    summary: args.summary,
    entityType: "TestDriveBooking",
    entityId: args.booking.id,
    contactId: args.booking.contactId,
    leadId: args.booking.leadId,
    user: args.user,
    before: args.before,
    after: args.after,
  });
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

/**
 * A test drive names TWO people, and which of them was rejected is the whole
 * content of the message — hence the `label`, which the shared contract already
 * takes for exactly this reason. Only the private copy of the membership rule is
 * gone; the distinction it drew is not.
 *
 * The one thing this adds over `resolveAssignableUser` is that a BLANK id is an
 * error rather than "deliberately unassigned". Everywhere else a cleared picker
 * legitimately means nobody; here both fields name a person, and the copy this
 * replaces refused a blank id too. Callers already guarantee it — the optional
 * second salesperson is guarded by a ternary — so this is the guard staying shut,
 * not a new one.
 */
async function requireAssignableStaff(userId: string, label: string) {
  const member = await resolveAssignableUser(userId, label);
  if (!member) throw new ActionRefusal(assignmentRefusalMessage(label));
  return member;
}

export async function createTestDriveBooking(formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requirePermission("activities.manage");
    const contactId = requiredText(formData, "contactId", "Customer");
    const leadId = text(formData, "leadId");
    await assertTestDriveCustomerAccess(user, contactId, leadId);

    const demoVehicleId = text(formData, "demoVehicleId");
    const productId = text(formData, "productId");
    const salespersonId = text(formData, "salespersonId") ?? user.id;
    const accompanyingSalespersonId = text(formData, "accompanyingSalespersonId");
    const branch = requiredText(formData, "branch", "Branch");
    const scheduledStart = localDateTime(text(formData, "scheduledStart"), "Start time");
    const expectedReturnAt = localDateTime(text(formData, "expectedReturnAt"), "Expected return");
    if (expectedReturnAt <= scheduledStart) throw new Error("Expected return must be after the start time");

    const [contact, lead, salesperson, accompanying, demoVehicle, product] = await Promise.all([
      prisma.contact.findFirst({ where: { id: contactId, deletedAt: null } }),
      leadId ? prisma.lead.findFirst({ where: { id: leadId, deletedAt: null } }) : null,
      requireAssignableStaff(salespersonId, "salesperson"),
      accompanyingSalespersonId
        ? requireAssignableStaff(accompanyingSalespersonId, "accompanying salesperson")
        : null,
      demoVehicleId ? prisma.demoVehicle.findFirst({ where: { id: demoVehicleId, deletedAt: null } }) : null,
      productId ? prisma.product.findFirst({ where: { id: productId, deletedAt: null } }) : null,
    ]);
    if (!contact) throw new Error("Customer not found");
    if (leadId && !lead) throw new Error("Lead not found");
    if (lead && lead.contactId && lead.contactId !== contactId) throw new Error("The selected lead belongs to a different customer");
    if (!salesperson) throw new Error("Salesperson not found");
    if (accompanyingSalespersonId && !accompanying) throw new Error("Accompanying salesperson not found");
    if (demoVehicleId && !demoVehicle) throw new Error("Demo vehicle not found");
    if (productId && !product) throw new Error("Product not found");
    await assertDemoVehicleAvailable({ demoVehicleId, start: scheduledStart, end: expectedReturnAt });

    const resolvedProductId = productId ?? demoVehicle?.productId ?? lead?.productId ?? null;
    const modelName = product?.name ?? demoVehicle?.name ?? lead?.title ?? "Vehicle";
    const activityId = crypto.randomUUID();
    // Both parents are already in hand, so the owner is decided without another read.
    // Activity's composite keys are (tenantId, contactId) and (tenantId, leadId). If
    // the contact and the lead disagree this THROWS rather than writing NULL: a NULL
    // tenant would switch off both composite checks and book a test drive spanning two
    // workspaces. The lead/contact mismatch guard above catches the ordinary case; this
    // is the database-level backstop for the case it does not.
    const activityTenantId = agreedTenantId(
      [contact.tenantId, ...(lead ? [lead.tenantId] : [])],
      null,
    );

    // The workspace the session is acting as. Resolved BEFORE the transaction: it
    // reads the session cookie, and doing that inside an open transaction holds a
    // connection for the duration of an unrelated await.
    const bookingTenantId = await actingTenantId();

    const booking = await prisma.$transaction(async (tx) => {
      const created = await tx.testDriveBooking.create({
        data: {
          // Stamped from the SESSION, not left to the db.ts guard. The guard's
          // `scopeArgs` returns its args untouched unless `tenantEnforcing()`, and
          // enforcement is dormant in every environment — so this row was being
          // written with a NULL tenant (2 of 2 on production at the 2026-08-10
          // audit) and would have vanished from the workspace that booked it the
          // moment enforcement flipped.
          //
          // NOTE for whoever owns Activity: the sibling `tx.activity.create` below
          // is the same defect and is deliberately NOT touched here — Activity is
          // on the other half of the audit list (14 of 61 unowned) and belongs in
          // that change, not this one.
          tenantId: bookingTenantId,
          reference: newReference(),
          status: "booked",
          leadId,
          contactId,
          branch,
          demoVehicleId,
          productId: resolvedProductId,
          salespersonId,
          accompanyingSalespersonId,
          activityId,
          scheduledStart,
          expectedReturnAt,
        },
      });
      await tx.activity.create({
        data: {
          id: activityId,
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
          tenantId: activityTenantId,
        },
      });
      return created;
    });

    await auditBooking({
      action: "test_drive.created",
      summary: `Booked test drive ${booking.reference}`,
      user,
      booking,
      after: booking,
    });
    revalidatePath("/test-drives");
    revalidatePath("/calendar");
    redirect(`/test-drives/${booking.id}`);
  });
}

export async function updateTestDriveBooking(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requireTestDriveManageAccess(id);
    const before = await requireBooking(id);
    if (!["booked", "confirmed"].includes(before.status)) {
      throw new Error("Only upcoming test drives can be rescheduled");
    }
    const branch = requiredText(formData, "branch", "Branch");
    const demoVehicleId = text(formData, "demoVehicleId");
    const salespersonId = requiredText(formData, "salespersonId", "Salesperson");
    const accompanyingSalespersonId = text(formData, "accompanyingSalespersonId");
    const scheduledStart = localDateTime(text(formData, "scheduledStart"), "Start time");
    const expectedReturnAt = localDateTime(text(formData, "expectedReturnAt"), "Expected return");
    if (expectedReturnAt <= scheduledStart) throw new Error("Expected return must be after the start time");
    await assertDemoVehicleAvailable({ demoVehicleId, start: scheduledStart, end: expectedReturnAt, excludeBookingId: id });

    await Promise.all([
      requireAssignableStaff(salespersonId, "salesperson"),
      accompanyingSalespersonId
        ? requireAssignableStaff(accompanyingSalespersonId, "accompanying salesperson")
        : Promise.resolve(null),
    ]);

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
    await auditBooking({ action: "test_drive.updated", summary: `Updated ${updated.reference}`, user, booking: updated, before, after: updated });
    revalidatePath("/test-drives");
    revalidatePath(`/test-drives/${id}`);
    revalidatePath("/calendar");
  });
}

export async function confirmTestDrive(id: string) {
  return withActingStaffScope(async () => {
    const user = await requireTestDriveManageAccess(id);
    const before = await requireBooking(id);
    if (before.status !== "booked") throw new Error("Only booked test drives can be confirmed");
    const updated = await prisma.testDriveBooking.update({ where: { id }, data: { status: "confirmed" } });
    await auditBooking({ action: "test_drive.confirmed", summary: `Confirmed ${updated.reference}`, user, booking: updated, before, after: updated });
    revalidatePath("/test-drives");
    revalidatePath(`/test-drives/${id}`);
  });
}

export async function saveDriverControls(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requireTestDriveManageAccess(id);
    const before = await requireBooking(id);
    if (!["booked", "confirmed"].includes(before.status)) throw new Error("Driver controls are locked after check-out");
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
    await auditBooking({ action: "test_drive.driver_controls_updated", summary: `Updated driver controls for ${updated.reference}`, user, booking: updated, before, after: updated });
    revalidatePath(`/test-drives/${id}`);
  });
}

export async function checkOutTestDrive(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requireTestDriveManageAccess(id);
    const before = await requireBooking(id);
    if (!["booked", "confirmed"].includes(before.status)) throw new Error("This test drive cannot be checked out");
    if (!before.demoVehicleId) throw new Error("Assign a demo vehicle before check-out");
    if (!before.driverLicenceNumber) throw new Error("Capture the driver's licence number before check-out");
    if (!before.driverLicenceExpiry) throw new Error("Capture the driver's licence expiry before check-out");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (before.driverLicenceExpiry < today) throw new Error("The driver's licence has expired");
    if (!before.identityVerifiedAt) throw new Error("Verify the driver's identity before check-out");
    if (before.indemnityStatus === "pending") throw new Error("Complete or waive the indemnity before check-out");
    if (!before.emergencyContactName || !before.emergencyContactPhone) throw new Error("Capture an emergency contact before check-out");

    const [licenceEvidence, conditionEvidence] = await Promise.all([
      prisma.testDriveAsset.count({ where: { bookingId: id, kind: "driver_licence" } }),
      prisma.testDriveAsset.count({ where: { bookingId: id, kind: "start_condition" } }),
    ]);
    if (!licenceEvidence) throw new Error("Upload the driver's licence or ID before check-out");
    if (!conditionEvidence) throw new Error("Add at least one start-condition photo before check-out");

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
    await auditBooking({ action: "test_drive.checked_out", summary: `Checked out ${updated.reference}`, user, booking: updated, before, after: updated });
    revalidatePath("/test-drives");
    revalidatePath("/test-drives/demo-fleet");
    revalidatePath(`/test-drives/${id}`);
  });
}

export async function completeTestDrive(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requireTestDriveManageAccess(id);
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
      if (!(await canAccessQuote(user, convertedQuoteId))) {
        throw new Error("You do not have access to that quote");
      }
      const quote = await prisma.quote.findFirst({ where: { id: convertedQuoteId, deletedAt: null } });
      if (!quote || (quote.contactId && quote.contactId !== before.contactId)) throw new Error("The selected quote is not available for this customer");
    }

    const returnedAt = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.testDriveBooking.update({
        where: { id },
        data: {
          status: "completed",
          actualReturnAt: returnedAt,
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
        await tx.activity.update({ where: { id: before.activityId }, data: { status: "done", doneAt: returnedAt } });
      }
      return result;
    });
    await auditBooking({ action: "test_drive.completed", summary: `Completed ${updated.reference}`, user, booking: updated, before, after: updated });
    revalidatePath("/test-drives");
    revalidatePath("/test-drives/demo-fleet");
    revalidatePath(`/test-drives/${id}`);
    revalidatePath("/calendar");
  });
}

export async function cancelTestDrive(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requireTestDriveManageAccess(id);
    const before = await requireBooking(id);
    if (!["booked", "confirmed"].includes(before.status)) throw new Error("Only an upcoming test drive can be cancelled");
    const reason = requiredText(formData, "reason", "Cancellation reason");
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.testDriveBooking.update({ where: { id }, data: { status: "cancelled", cancellationReason: reason } });
      if (before.activityId) await tx.activity.update({ where: { id: before.activityId }, data: { status: "canceled" } });
      return result;
    });
    await auditBooking({ action: "test_drive.cancelled", summary: `Cancelled ${updated.reference}`, user, booking: updated, before, after: updated });
    revalidatePath("/test-drives");
    revalidatePath(`/test-drives/${id}`);
    revalidatePath("/calendar");
  });
}

export async function markTestDriveNoShow(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requireTestDriveManageAccess(id);
    const before = await requireBooking(id);
    if (!["booked", "confirmed"].includes(before.status)) throw new Error("Only an upcoming test drive can be marked no-show");
    const reason = text(formData, "reason");
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.testDriveBooking.update({ where: { id }, data: { status: "no_show", noShowReason: reason } });
      if (before.activityId) await tx.activity.update({ where: { id: before.activityId }, data: { status: "canceled" } });
      return result;
    });
    await auditBooking({ action: "test_drive.no_show", summary: `Marked ${updated.reference} as no-show`, user, booking: updated, before, after: updated });
    revalidatePath("/test-drives");
    revalidatePath(`/test-drives/${id}`);
    revalidatePath("/calendar");
  });
}

export async function createDemoVehicle(formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requirePermission("vehicles.manage");
    const name = requiredText(formData, "name", "Display name");
    const selectedProductId = text(formData, "productId");
    const stockUnitId = text(formData, "stockUnitId");
    const stockUnit = stockUnitId
      ? await prisma.stockUnit.findFirst({ where: { id: stockUnitId, deletedAt: null } })
      : null;
    if (stockUnitId && !stockUnit) throw new Error("Stock unit not found");
    if (stockUnitId) {
      const existing = await prisma.demoVehicle.findFirst({ where: { stockUnitId, deletedAt: null } });
      if (existing) throw new Error("That stock unit is already in the demo fleet");
    }
    const productId = selectedProductId ?? stockUnit?.productId ?? null;
    if (productId) {
      const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null } });
      if (!product) throw new Error("Product not found");
      if (stockUnit && stockUnit.productId !== productId) throw new Error("The selected product does not match the stock unit");
    }

    const demo = await prisma.demoVehicle.create({
      data: {
        name,
        productId,
        stockUnitId,
        vin: text(formData, "vin") ?? stockUnit?.serial ?? null,
        regNumber: text(formData, "regNumber"),
        color: text(formData, "color") ?? stockUnit?.color ?? null,
        branch: text(formData, "branch") ?? stockUnit?.location ?? null,
        odometerKm: intValue(formData, "odometerKm") ?? stockUnit?.odometerKm ?? 0,
        batteryLevelPct: percentValue(formData, "batteryLevelPct"),
        notes: text(formData, "notes"),
      },
    });
    await logAuditStrict({ action: "demo_vehicle.created", summary: `Added demo vehicle ${demo.name}`, entityType: "DemoVehicle", entityId: demo.id, user, after: demo });
    revalidatePath("/test-drives");
    revalidatePath("/test-drives/demo-fleet");
  });
}

export async function updateDemoVehicle(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requirePermission("vehicles.manage");
    const before = await prisma.demoVehicle.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new Error("Demo vehicle not found");
    const status = requiredText(formData, "status", "Status");
    if (!["active", "maintenance", "unavailable", "retired"].includes(status)) throw new Error("Invalid demo vehicle status");
    if (status !== "active") {
      // Match the prevent_unavailable_demo_with_live_bookings DB trigger, which
      // blocks booked/confirmed/checked_out — not just checked_out. Otherwise a
      // vehicle with a future *booked* drive passes this check and then throws a raw
      // 23514 from the trigger instead of a friendly message.
      const activeDrive = await prisma.testDriveBooking.findFirst({
        where: { demoVehicleId: id, status: { in: ["booked", "confirmed", "checked_out"] }, deletedAt: null },
        select: { reference: true },
      });
      if (activeDrive) throw new Error(`${activeDrive.reference} has a live booking on this vehicle`);
    }
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
  });
}

const ALLOWED_ASSET_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const ALLOWED_ASSET_KINDS = new Set(["driver_licence", "start_condition", "return_condition", "incident", "other"]);

export async function uploadTestDriveAsset(id: string, kind: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requireTestDriveManageAccess(id);
    const booking = await requireBooking(id);
    if (!ALLOWED_ASSET_KINDS.has(kind)) throw new Error("Invalid asset type");
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose a file to upload");
    if (file.size > 10 * 1024 * 1024) throw new Error("Files must be 10 MB or smaller");
    if (!ALLOWED_ASSET_TYPES.has(file.type)) throw new Error("Use PDF, JPG, PNG or WebP files");
    // A licence scan or condition photo is evidence about THIS booking, so the
    // booking owns it — and TestDriveAsset carries a composite (tenantId, bookingId)
    // key holding the row to the same answer.
    const storedName = await saveFile(Buffer.from(await file.arrayBuffer()), file.name, file.type, booking.tenantId);
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
    await logAuditStrict({
      action: "test_drive.asset_uploaded",
      summary: `Uploaded ${kind.replaceAll("_", " ")} for ${booking.reference}`,
      entityType: "TestDriveAsset",
      entityId: asset.id,
      contactId: booking.contactId,
      leadId: booking.leadId,
      user,
      after: asset,
    });
    revalidatePath(`/test-drives/${id}`);
  });
}
