"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addMonths } from "date-fns";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { sendReviewRequest } from "@/lib/reviewRequests";
import { triggerSurvey } from "@/lib/surveys";
import { softDeleteRecord } from "@/lib/trash";
import { saveFile } from "@/lib/storage";
import { parseRands } from "@/lib/format";
import { STAGE_VALUES, PRIORITY_VALUES, stageMeta } from "@/lib/workshop-constants";
import {
  requireJobCardAccess,
  requireVehicleAccess,
} from "@/lib/permissions";

export async function uploadJobCardPhotos(jobCardId: string, formData: FormData) {
  const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
  const jobCard = await prisma.jobCard.findUniqueOrThrow({ where: { id: jobCardId } });
  const files = formData
    .getAll("files")
    .filter((f): f is File => typeof f === "object" && (f as File).size > 0);
  let saved = 0;
  for (const file of files.slice(0, 12)) {
    if (file.size > 4 * 1024 * 1024 || !file.type.startsWith("image/")) continue;
    const buf = Buffer.from(await file.arrayBuffer());
    const storedName = await saveFile(buf, file.name || "checkin.jpg", file.type);
    await prisma.document.create({
      data: {
        fileName: `Check-in photo — job card #${jobCard.number} — ${file.name}`,
        storedName,
        mimeType: file.type,
        sizeBytes: file.size,
        contactId: jobCard.contactId,
        jobCardId,
        tag: "checkin-photo",
        uploadedById: user.id,
      },
    });
    saved++;
  }
  if (saved > 0) {
    await logAudit({
      action: "jobcard.photos",
      summary: `${saved} check-in photo${saved !== 1 ? "s" : ""} added to job card #${jobCard.number} (pre-work condition)`,
      contactId: jobCard.contactId,
      user,
    });
  }
  revalidatePath(`/jobcards/${jobCardId}`);
}

export async function createJobCard(formData: FormData) {
  const vehicleId = String(formData.get("vehicleId") ?? "");
  const description = String(formData.get("description") ?? "").trim();
  if (!vehicleId || !description) throw new Error("Vehicle and description are required");
  const user = await requireVehicleAccess(vehicleId, "jobcards.manage");

  const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
  const kmInRaw = String(formData.get("kmIn") ?? "").trim();
  const kmIn = kmInRaw === "" ? null : parseInt(kmInRaw, 10);

  const max = await prisma.jobCard.aggregate({ _max: { number: true } });
  const jobCard = await prisma.jobCard.create({
    data: {
      number: (max._max.number ?? 1000) + 1,
      vehicleId,
      contactId: vehicle.contactId,
      description,
      kmIn: kmIn != null && !isNaN(kmIn) ? kmIn : null,
      technicianId: user.id,
    },
  });
  if (jobCard.kmIn != null) {
    await prisma.mileageLog.create({
      data: { vehicleId, km: jobCard.kmIn, note: `Job card #${jobCard.number} check-in` },
    });
  }
  await logAudit({
    action: "jobcard.opened",
    summary: `Opened job card #${jobCard.number} on ${vehicle.model}: ${description}`,
    contactId: vehicle.contactId,
    user,
  });
  revalidatePath("/jobcards");
  redirect(`/jobcards/${jobCard.id}`);
}

export async function addJobCardItem(jobCardId: string, formData: FormData) {
  await requireJobCardAccess(jobCardId, "jobcards.manage");
  const description = String(formData.get("description") ?? "").trim();
  if (!description) return;
  const qty = parseFloat(String(formData.get("qty") ?? "1")) || 1;
  const kind = String(formData.get("kind") ?? "part");
  const partId = String(formData.get("partId") ?? "").trim() || null;
  await prisma.jobCardItem.create({
    data: {
      jobCardId,
      kind,
      description,
      qty,
      unitPriceCents: parseRands(String(formData.get("unitPrice") ?? "")),
      partId,
    },
  });
  if (partId && kind === "part") {
    await prisma.part.update({
      where: { id: partId },
      data: { stockQty: { decrement: Math.round(qty) } },
    });
  }
  revalidatePath(`/jobcards/${jobCardId}`);
}

export async function deleteJobCardItem(id: string, jobCardId: string, formData: FormData) {
  const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const item = await prisma.jobCardItem.delete({ where: { id } });
  if (item.partId && item.kind === "part") {
    await prisma.part.update({
      where: { id: item.partId },
      data: { stockQty: { increment: Math.round(item.qty) } },
    }).catch(() => {});
  }
  const jobCard = await prisma.jobCard.findUnique({ where: { id: jobCardId } });
  await logAudit({
    action: "jobcard.item_deleted",
    summary: `Removed “${item.description}” from job card #${jobCard?.number ?? "?"} — ${reason}`,
    contactId: jobCard?.contactId,
    user,
  });
  revalidatePath(`/jobcards/${jobCardId}`);
}

export async function setJobCardTechnician(jobCardId: string, formData: FormData) {
  await requireJobCardAccess(jobCardId, "jobcards.manage");
  const technicianId = String(formData.get("technicianId") ?? "").trim() || null;
  await prisma.jobCard.update({ where: { id: jobCardId }, data: { technicianId } });
  revalidatePath(`/jobcards/${jobCardId}`);
}

// Moving to any workflow stage (or cancelling / reopening). "collected" is
// reserved for completeJobCard, which also creates the service record.
export async function setJobCardStatus(jobCardId: string, status: string) {
  const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
  const allowed = new Set(STAGE_VALUES.filter((s) => s !== "collected"));
  if (!allowed.has(status)) throw new Error("Invalid job card status");
  const jobCard = await prisma.jobCard.findUniqueOrThrow({ where: { id: jobCardId }, select: { number: true, contactId: true, status: true } });
  await prisma.jobCard.update({
    where: { id: jobCardId },
    data: { status, completedAt: null },
  });
  await logAudit({
    action: "jobcard.stage",
    summary: `Job card #${jobCard.number}: ${stageMeta(jobCard.status).label} → ${stageMeta(status).label}`,
    contactId: jobCard.contactId,
    user,
  });
  revalidatePath("/jobcards");
  revalidatePath(`/jobcards/${jobCardId}`);
}

export async function setJobCardPriority(jobCardId: string, formData: FormData) {
  await requireJobCardAccess(jobCardId, "jobcards.manage");
  const priority = String(formData.get("priority") ?? "normal");
  if (!PRIORITY_VALUES.includes(priority)) return;
  await prisma.jobCard.update({ where: { id: jobCardId }, data: { priority } });
  revalidatePath("/jobcards");
  revalidatePath(`/jobcards/${jobCardId}`);
}

export async function setJobCardBay(jobCardId: string, formData: FormData) {
  await requireJobCardAccess(jobCardId, "jobcards.manage");
  const bayId = String(formData.get("bayId") ?? "").trim() || null;
  await prisma.jobCard.update({ where: { id: jobCardId }, data: { bayId } });
  revalidatePath(`/jobcards/${jobCardId}`);
}

export async function setJobCardEstimate(jobCardId: string, formData: FormData) {
  await requireJobCardAccess(jobCardId, "jobcards.manage");
  const hoursRaw = String(formData.get("estimatedHours") ?? "").trim();
  const rateRaw = String(formData.get("labourRate") ?? "").trim();
  const estimatedHours = hoursRaw === "" ? null : Math.max(0, parseFloat(hoursRaw) || 0);
  const labourRateCents = rateRaw === "" ? null : parseRands(rateRaw);
  await prisma.jobCard.update({
    where: { id: jobCardId },
    data: { estimatedHours, labourRateCents },
  });
  revalidatePath(`/jobcards/${jobCardId}`);
}

// ── Technician time clock ────────────────────────────────────────────────────
// A technician has at most one running clock at a time. Starting one auto-stops
// any other running entry they left open (on this or another job).
export async function startTimeEntry(jobCardId: string, formData: FormData) {
  const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
  const note = String(formData.get("note") ?? "").trim() || null;
  await prisma.jobCardTimeEntry.updateMany({
    where: { technicianId: user.id, endedAt: null },
    data: { endedAt: new Date() },
  });
  await prisma.jobCardTimeEntry.create({
    data: { jobCardId, technicianId: user.id, note },
  });
  revalidatePath(`/jobcards/${jobCardId}`);
}

export async function stopTimeEntry(jobCardId: string) {
  const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
  await prisma.jobCardTimeEntry.updateMany({
    where: { jobCardId, technicianId: user.id, endedAt: null },
    data: { endedAt: new Date() },
  });
  revalidatePath(`/jobcards/${jobCardId}`);
}

export async function deleteTimeEntry(entryId: string, jobCardId: string) {
  await requireJobCardAccess(jobCardId, "jobcards.manage");
  await prisma.jobCardTimeEntry.delete({ where: { id: entryId } }).catch(() => {});
  revalidatePath(`/jobcards/${jobCardId}`);
}

export async function completeJobCard(jobCardId: string, formData: FormData) {
  const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
  const jobCard = await prisma.jobCard.findUniqueOrThrow({
    where: { id: jobCardId },
    include: { vehicle: true },
  });

  const str = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  const kmRaw = str("km");
  const km = kmRaw != null ? parseInt(kmRaw, 10) : jobCard.kmIn;
  const summary = str("summary") ?? jobCard.description;

  let nextDueKm = str("nextDueKm") != null ? parseInt(String(str("nextDueKm")), 10) : null;
  let nextDueDate = str("nextDueDate") ? new Date(String(str("nextDueDate"))) : null;
  if (nextDueKm == null && km != null && jobCard.vehicle.serviceIntervalKm) {
    nextDueKm = km + jobCard.vehicle.serviceIntervalKm;
  }
  if (nextDueDate == null && jobCard.vehicle.serviceIntervalMonths) {
    nextDueDate = addMonths(new Date(), jobCard.vehicle.serviceIntervalMonths);
  }

  await prisma.$transaction([
    prisma.jobCard.update({
      where: { id: jobCardId },
      data: { status: "collected", completedAt: new Date() },
    }),
    prisma.serviceRecord.create({
      data: {
        vehicleId: jobCard.vehicleId,
        jobCardId,
        summary,
        details: str("details"),
        km: km != null && !isNaN(km) ? km : null,
        nextDueKm: nextDueKm != null && !isNaN(nextDueKm) ? nextDueKm : null,
        nextDueDate,
        performedById: user.id,
      },
    }),
  ]);
  if (km != null && !isNaN(km)) {
    await prisma.mileageLog.create({
      data: { vehicleId: jobCard.vehicleId, km, note: `Job card #${jobCard.number} completed` },
    });
  }
  await logAudit({
    action: "jobcard.completed",
    summary: `Completed job card #${jobCard.number} on ${jobCard.vehicle.model}: ${summary}`,
    contactId: jobCard.contactId,
    user,
  });
  await sendReviewRequest(
    jobCard.contactId,
    "service",
    `the service on your ${jobCard.vehicle.model} (job card #${jobCard.number})`
  ).catch(() => {});
  await triggerSurvey("job_complete", {
    contactId: jobCard.contactId,
    jobCardId: jobCard.id,
  });
  revalidatePath("/jobcards");
  revalidatePath(`/jobcards/${jobCardId}`);
  revalidatePath(`/vehicles/${jobCard.vehicleId}`);
  revalidatePath("/vehicles");
}

export async function deleteJobCard(id: string, formData: FormData) {
  const user = await requireJobCardAccess(id, "jobcards.manage");
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const jobCard = await softDeleteRecord("jobCard", id, reason, user.name);
  await logAudit({
    action: "trash.deleted",
    summary: `Moved job card #${jobCard.number} to trash — ${reason}`,
    contactId: jobCard.contactId,
    user,
  });
  revalidatePath("/jobcards");
  redirect("/jobcards");
}

// ── Condition notes & check-out photos (phase 2) ──────────────────────────────
export async function saveConditionNotes(jobCardId: string, formData: FormData) {
  await requireJobCardAccess(jobCardId, "jobcards.manage");
  const checkinNotes = String(formData.get("checkinNotes") ?? "").trim() || null;
  const checkoutNotes = String(formData.get("checkoutNotes") ?? "").trim() || null;
  await prisma.jobCard.update({ where: { id: jobCardId }, data: { checkinNotes, checkoutNotes } });
  revalidatePath(`/jobcards/${jobCardId}`);
}

export async function uploadCheckoutPhotos(jobCardId: string, formData: FormData) {
  const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
  const jobCard = await prisma.jobCard.findUniqueOrThrow({ where: { id: jobCardId } });
  const files = formData.getAll("files").filter((f): f is File => typeof f === "object" && (f as File).size > 0);
  let saved = 0;
  for (const file of files.slice(0, 12)) {
    if (file.size > 4 * 1024 * 1024 || !file.type.startsWith("image/")) continue;
    const buf = Buffer.from(await file.arrayBuffer());
    const storedName = await saveFile(buf, file.name || "checkout.jpg", file.type);
    await prisma.document.create({
      data: {
        fileName: `Check-out photo — job card #${jobCard.number} — ${file.name}`,
        storedName,
        mimeType: file.type,
        sizeBytes: file.size,
        contactId: jobCard.contactId,
        jobCardId,
        tag: "checkout-photo",
        uploadedById: user.id,
      },
    });
    saved++;
  }
  if (saved > 0) {
    await logAudit({ action: "jobcard.photos", summary: `${saved} check-out photo${saved !== 1 ? "s" : ""} added to job card #${jobCard.number} (post-work condition)`, contactId: jobCard.contactId, user });
  }
  revalidatePath(`/jobcards/${jobCardId}`);
}

// ── Inspection checklist (phase 2) ────────────────────────────────────────────
export async function addInspectionItem(jobCardId: string, formData: FormData) {
  await requireJobCardAccess(jobCardId, "jobcards.manage");
  const label = String(formData.get("label") ?? "").trim();
  if (!label) return;
  const status = String(formData.get("status") ?? "ok");
  const max = await prisma.jobCardInspectionItem.aggregate({ where: { jobCardId }, _max: { sortOrder: true } });
  await prisma.jobCardInspectionItem.create({
    data: { jobCardId, label, status, sortOrder: (max._max.sortOrder ?? 0) + 1 },
  });
  revalidatePath(`/jobcards/${jobCardId}`);
}

export async function setInspectionItem(itemId: string, jobCardId: string, formData: FormData) {
  await requireJobCardAccess(jobCardId, "jobcards.manage");
  const status = String(formData.get("status") ?? "ok");
  const notes = String(formData.get("notes") ?? "").trim() || null;
  await prisma.jobCardInspectionItem.update({ where: { id: itemId }, data: { status, notes } });
  revalidatePath(`/jobcards/${jobCardId}`);
}

export async function deleteInspectionItem(itemId: string, jobCardId: string) {
  await requireJobCardAccess(jobCardId, "jobcards.manage");
  await prisma.jobCardInspectionItem.delete({ where: { id: itemId } }).catch(() => {});
  revalidatePath(`/jobcards/${jobCardId}`);
}

export async function uploadInspectionPhoto(itemId: string, jobCardId: string, formData: FormData) {
  await requireJobCardAccess(jobCardId, "jobcards.manage");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return;
  if (file.size > 4 * 1024 * 1024 || !file.type.startsWith("image/")) return;
  const buf = Buffer.from(await file.arrayBuffer());
  const storedName = await saveFile(buf, file.name || "inspection.jpg", file.type);
  await prisma.jobCardInspectionItem.update({ where: { id: itemId }, data: { photoStoredName: storedName } });
  revalidatePath(`/jobcards/${jobCardId}`);
}

// ── Additional-work approval (phase 2) ────────────────────────────────────────
export async function requestAdditionalWork(jobCardId: string, formData: FormData) {
  const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
  const description = String(formData.get("description") ?? "").trim();
  if (!description) return;
  const amountCents = parseRands(String(formData.get("amount") ?? ""));
  const jobCard = await prisma.jobCard.findUniqueOrThrow({ where: { id: jobCardId }, select: { number: true, contactId: true } });
  await prisma.jobCardApproval.create({
    data: { jobCardId, description, amountCents, createdById: user.id },
  });
  // Notify the customer in their portal (PortalNotification is a raw-SQL table on this base).
  await prisma.$executeRaw`
    INSERT INTO "PortalNotification" ("id","contactId","title","body","href","kind")
    VALUES (${randomUUID()}, ${jobCard.contactId}, ${"Additional work needs your approval"},
      ${`Job card #${jobCard.number}: ${description}${amountCents ? ` — R${(amountCents / 100).toFixed(2)}` : ""}`},
      ${"/portal/support"}, ${"jobcard"})`.catch(() => {});
  await logAudit({ action: "jobcard.approval_requested", summary: `Requested approval for additional work on job card #${jobCard.number}: ${description}`, contactId: jobCard.contactId, user });
  revalidatePath(`/jobcards/${jobCardId}`);
}

export async function decideApproval(approvalId: string, jobCardId: string, decision: "approved" | "declined", formData: FormData) {
  const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
  const decidedVia = String(formData.get("decidedVia") ?? "phone");
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const approval = await prisma.jobCardApproval.update({
    where: { id: approvalId },
    data: { status: decision, decidedVia, decidedAt: new Date(), notes },
    include: { jobCard: { select: { number: true, contactId: true } } },
  });
  await logAudit({ action: "jobcard.approval_decided", summary: `Additional work ${decision} (${decidedVia}) on job card #${approval.jobCard.number}: ${approval.description}`, contactId: approval.jobCard.contactId, user });
  revalidatePath(`/jobcards/${jobCardId}`);
}

export async function deleteApproval(approvalId: string, jobCardId: string) {
  await requireJobCardAccess(jobCardId, "jobcards.manage");
  await prisma.jobCardApproval.delete({ where: { id: approvalId } }).catch(() => {});
  revalidatePath(`/jobcards/${jobCardId}`);
}

// ── Subcontracting (phase 3) ──────────────────────────────────────────────────
export async function saveSubcontract(jobCardId: string, formData: FormData) {
  await requireJobCardAccess(jobCardId, "jobcards.manage");
  const isSubcontracted = formData.get("isSubcontracted") === "on";
  const subcontractor = String(formData.get("subcontractor") ?? "").trim() || null;
  const subCostCents = parseRands(String(formData.get("subCost") ?? ""));
  await prisma.jobCard.update({ where: { id: jobCardId }, data: { isSubcontracted, subcontractor, subCostCents } });
  revalidatePath(`/jobcards/${jobCardId}`);
}

// ── Part reservations (phase 3) ───────────────────────────────────────────────
// A reservation earmarks stock without consuming it. Available = stockQty minus
// active reservations. Consuming turns a reservation into a job-card part line
// and decrements stock.
export async function reservePart(jobCardId: string, formData: FormData) {
  const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
  const partId = String(formData.get("partId") ?? "").trim();
  if (!partId) return;
  const qty = Math.max(1, parseInt(String(formData.get("qty") ?? "1"), 10) || 1);
  const [part, jobCard] = await Promise.all([
    prisma.part.findUnique({ where: { id: partId }, select: { name: true } }),
    prisma.jobCard.findUnique({ where: { id: jobCardId }, select: { number: true, contactId: true } }),
  ]);
  await prisma.partReservation.create({ data: { jobCardId, partId, qty } });
  await logAudit({ action: "jobcard.part_reserved", summary: `Reserved ${qty}× ${part?.name ?? "part"} for job card #${jobCard?.number ?? "?"}`, contactId: jobCard?.contactId, user });
  revalidatePath(`/jobcards/${jobCardId}`);
  revalidatePath("/parts");
}

export async function releaseReservation(reservationId: string, jobCardId: string) {
  await requireJobCardAccess(jobCardId, "jobcards.manage");
  await prisma.partReservation.update({ where: { id: reservationId }, data: { status: "released" } }).catch(() => {});
  revalidatePath(`/jobcards/${jobCardId}`);
  revalidatePath("/parts");
}

export async function consumeReservation(reservationId: string, jobCardId: string) {
  await requireJobCardAccess(jobCardId, "jobcards.manage");
  const reservation = await prisma.partReservation.findUnique({ where: { id: reservationId }, include: { part: true } });
  if (!reservation || reservation.status !== "active") return;
  await prisma.$transaction([
    prisma.jobCardItem.create({
      data: { jobCardId, kind: "part", description: reservation.part.name, qty: reservation.qty, unitPriceCents: reservation.part.priceCents, partId: reservation.partId },
    }),
    prisma.part.update({ where: { id: reservation.partId }, data: { stockQty: { decrement: reservation.qty } } }),
    prisma.partReservation.update({ where: { id: reservationId }, data: { status: "consumed" } }),
  ]);
  revalidatePath(`/jobcards/${jobCardId}`);
  revalidatePath("/parts");
}

// ── Service packages (phase 3) ────────────────────────────────────────────────
export async function applyServicePackage(jobCardId: string, formData: FormData) {
  await requireJobCardAccess(jobCardId, "jobcards.manage");
  const packageId = String(formData.get("packageId") ?? "").trim();
  if (!packageId) return;
  const pkg = await prisma.servicePackage.findUnique({ where: { id: packageId }, include: { items: true } });
  if (!pkg) return;
  for (const item of pkg.items) {
    await prisma.jobCardItem.create({
      data: { jobCardId, kind: item.kind, description: item.description, qty: item.qty, unitPriceCents: item.unitPriceCents, partId: item.partId },
    });
    if (item.partId && item.kind === "part") {
      await prisma.part.update({ where: { id: item.partId }, data: { stockQty: { decrement: Math.round(item.qty) } } }).catch(() => {});
    }
  }
  revalidatePath(`/jobcards/${jobCardId}`);
}
