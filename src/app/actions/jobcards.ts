"use server";

import { asActionResult, ActionRefusal, refuse, type ActionResult } from "@/lib/actionResult";
import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addMonths } from "date-fns";
import { prisma, basePrisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { nextJobCardNumber } from "@/lib/numbering";
import { actingTenantId } from "@/lib/actingTenant";
import { sendReviewRequest } from "@/lib/reviewRequests";
import { triggerSurvey } from "@/lib/surveys";
import { CLOSED_REQUEST_STATUSES } from "@/lib/signing/status";
import { MAX_PHOTOS, MAX_PHOTO_BYTES, checkUploadPayload } from "@/lib/photoBudget";
import { assertOwnedBlob, saveFile, deleteFile } from "@/lib/storage";
import { logError } from "@/lib/errorLog";
import { parseRands } from "@/lib/format";
import { Prisma } from "@prisma/client";
import { STAGE_VALUES, PRIORITY_VALUES, stageMeta } from "@/lib/workshop-constants";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { resolveAssignableUser } from "@/lib/tenantActor";
import {
  requireJobCardAccess,
  requireVehicleAccess,
} from "@/lib/permissions";

/**
 * Says what actually happened. Reporting "Photos uploaded" after silently
 * discarding half the selection is the same lie as reporting a save that never
 * ran, only quieter — the user walks away believing the record is complete.
 */
function photoMessage(saved: number, skipped: number): string {
  const base = `${saved} photo${saved === 1 ? "" : "s"} uploaded`;
  return skipped > 0
    ? `${base} — ${skipped} skipped (not an image, over 4 MB, or past the 12-photo limit)`
    : base;
}

export type StagedJobCardPhoto = { url: string };

export async function registerJobCardPhotos(
  jobCardId: string,
  staged: StagedJobCardPhoto[],
  category: "checkin" | "checkout" = "checkin",
): Promise<ActionResult> {
  const failureLog: { scope: string; context: string; tenantId?: string | null } = {
    scope: "jobcard-photo-finalize",
    context: `jobCard=${jobCardId} category=${category}`,
  };
  return asActionResult(async () => {
    const tenantId = await actingTenantId();
    failureLog.tenantId = tenantId;
    const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
    const jobCard = await basePrisma.jobCard.findFirst({
      where: { id: jobCardId, tenantId },
      select: { id: true, tenantId: true, number: true, contactId: true },
    });
    if (!jobCard?.tenantId) refuse("This job card is no longer available in this workspace.");

    const urls = [...new Set(staged.map((item) => String(item.url ?? "").trim()).filter(Boolean))];
    if (urls.length === 0) refuse("Choose at least one photo.");
    if (urls.length > MAX_PHOTOS) refuse(`Upload up to ${MAX_PHOTOS} job-card photos at a time.`);

    let saved = 0;
    let failed = 0;
    for (const [index, url] of urls.entries()) {
      try {
        const blob = await assertOwnedBlob(url, jobCard.tenantId);
        if (!blob.contentType.startsWith("image/")) throw new Error("Stored job-card evidence is not an image.");
        if (blob.size <= 0 || blob.size > MAX_PHOTO_BYTES) throw new Error("Stored job-card photo is outside the 4 MB limit.");
        if (!blob.pathname.startsWith(`uploads/${jobCard.tenantId}/${category === "checkout" ? "jobcard-checkout" : "jobcard"}/${jobCard.id}/`)) {
          throw new Error("Stored job-card photo is not bound to this job card.");
        }
        await prisma.document.create({
          data: {
            tenantId: jobCard.tenantId,
            fileName: `${category === "checkout" ? "Check-out" : "Check-in"} photo — job card #${jobCard.number} — ${index + 1}`,
            storedName: url,
            mimeType: blob.contentType,
            sizeBytes: blob.size,
            contactId: jobCard.contactId,
            jobCardId,
            tag: category === "checkout" ? "checkout-photo" : "checkin-photo",
            uploadedById: user.id,
          },
        });
        saved++;
      } catch (error) {
        failed++;
        await logError(
          "jobcard-photo-finalize",
          error,
          `jobCard=${jobCardId} photo=${index + 1}/${urls.length}`,
          { tenantId: jobCard.tenantId, alert: false },
        );
        await deleteFile(url).catch(async (cleanupError) => {
          await logError("jobcard-photo-cleanup", cleanupError, `jobCard=${jobCardId} photo=${index + 1}`, {
            tenantId: jobCard.tenantId,
            alert: false,
          });
        });
      }
    }
    if (saved === 0) {
      refuse("The photos were uploaded but could not be filed. See Settings → System Log under jobcard-photo-finalize.");
    }
    await logAudit({
      action: "jobcard.photos",
      summary: `${saved} ${category === "checkout" ? "check-out" : "check-in"} photo${saved === 1 ? "" : "s"} added to job card #${jobCard.number}`,
      contactId: jobCard.contactId,
      user,
    });
    revalidatePath(`/jobcards/${jobCardId}`);
    return {
      success: failed
        ? `${saved} photo${saved === 1 ? "" : "s"} uploaded — ${failed} failed and were logged`
        : `${saved} photo${saved === 1 ? "" : "s"} uploaded`,
    };
  }, failureLog);
}

export async function uploadJobCardPhotos(jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
    const jobCard = await prisma.jobCard.findUniqueOrThrow({ where: { id: jobCardId } });
    const files = formData
      .getAll("files")
      .filter((f): f is File => typeof f === "object" && (f as File).size > 0);
    // The input is not `required`, and invalid files were skipped silently — so
    // "Photos uploaded" could report saving nothing at all.
    if (files.length === 0) refuse("Choose at least one photo.");
    const accepted = files.filter(
      (file) => file.size <= MAX_PHOTO_BYTES && file.type.startsWith("image/"),
    );
    if (accepted.length === 0) {
      refuse("None of those files could be used — photos must be images under 4 MB.");
    }
    // The TOTAL, not just each file. Twelve files individually under 4 MB is 48 MB,
    // which the framework refuses before this function runs — so without this the
    // per-file limit was the only one enforced and the real ceiling was invisible.
    // checkUploadPayload states the same budget the client resizes against.
    const payload = checkUploadPayload(accepted.slice(0, MAX_PHOTOS).map((file) => file.size));
    if (!payload.ok) refuse(payload.reason);
    const skipped = (files.length - accepted.length) + Math.max(0, accepted.length - MAX_PHOTOS);
    let saved = 0;
    for (const file of accepted.slice(0, MAX_PHOTOS)) {
      const buf = Buffer.from(await file.arrayBuffer());
      // A condition photo is evidence about THIS job card, so the job card owns it —
      // not the technician's session, which can be a different workspace's admin.
      const storedName = await saveFile(buf, file.name || "checkin.jpg", file.type, jobCard.tenantId);
      await prisma.document.create({
        data: {
          fileName: `Check-in photo — job card #${jobCard.number} — ${file.name}`,
          storedName,
          mimeType: file.type,
          sizeBytes: file.size,
          contactId: jobCard.contactId,
          jobCardId,
          // The job card owns the row for the same reason it owns the blob above.
          tenantId: jobCard.tenantId,
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
    return { success: photoMessage(saved, skipped) };
  });
}

/**
 * Saves markup for a check-in / check-out condition photo: the re-editable vector
 * shapes (so it can be reopened and adjusted) plus a flattened image with the markup
 * burned in (for display / print / PDF). The original photo is never touched.
 */
export async function saveCheckinAnnotation(formData: FormData) {
  const documentId = String(formData.get("documentId") ?? "");
  const image = formData.get("image");
  if (!documentId || !(image instanceof File) || image.size === 0) {
    throw new Error("Missing annotation image");
  }
  const ext = image.type === "image/jpeg" ? "jpg" : image.type === "image/png" ? "png" : null;
  if (image.size > 10 * 1024 * 1024 || !ext) {
    throw new Error("Invalid annotation image");
  }

  const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  if (!doc.jobCardId || (doc.tag !== "checkin-photo" && doc.tag !== "checkout-photo")) {
    throw new Error("Not a condition photo");
  }
  const user = await requireJobCardAccess(doc.jobCardId, "jobcards.manage");

  let annotations: Prisma.InputJsonValue;
  try {
    annotations = JSON.parse(String(formData.get("annotations") ?? "null")) as Prisma.InputJsonValue;
  } catch {
    throw new Error("Invalid annotation data");
  }

  const buf = Buffer.from(await image.arrayBuffer());
  // The flattened markup is a derivative of the photo it annotates, so it belongs
  // exactly where that Document already does — a mismatch would leave the original
  // and its markup in two different workspaces' prefixes.
  const storedName = await saveFile(buf, `annotated-${doc.id}.${ext}`, image.type, doc.tenantId);
  const previous = doc.annotatedStoredName;

  await prisma.document.update({
    where: { id: doc.id },
    data: { annotations, annotatedStoredName: storedName },
  });

  // Replace, don't accumulate: drop the previous flattened version once the new one is stored.
  if (previous && previous !== storedName) {
    await deleteFile(previous).catch(() => {});
  }

  await logAudit({
    action: "jobcard.photo.annotate",
    summary: `Marked up a check-in photo (pre-work condition)`,
    contactId: doc.contactId,
    user,
  });
  revalidatePath(`/jobcards/${doc.jobCardId}`);
}

export async function createJobCard(formData: FormData) {
  // The automotive pack owns job cards; a stale quick-create dialog could still POST
  // this action after the pack is switched off, so reject it server-side.
  if (!(await isModuleEnabled("automotive"))) {
    throw new Error("The automotive module is disabled");
  }
  const vehicleId = String(formData.get("vehicleId") ?? "");
  const description = String(formData.get("description") ?? "").trim();
  if (!vehicleId || !description) throw new Error("Vehicle and description are required");
  const user = await requireVehicleAccess(vehicleId, "jobcards.manage");

  const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
  const kmInRaw = String(formData.get("kmIn") ?? "").trim();
  const kmIn = kmInRaw === "" ? null : parseInt(kmInRaw, 10);

  // Allocate the number and insert in ONE transaction under the advisory lock so
  // two concurrent job-card creates can't collide on the unique number (#11).
  // basePrisma is the RLS bypass: authorising the vehicle above did not scope
  // this transaction, so both rows carry their owner explicitly.
  const tenantId = await actingTenantId();
  const jobCard = await basePrisma.$transaction(async (tx) => {
    const number = await nextJobCardNumber(tx);
    const jc = await tx.jobCard.create({
      data: {
        number,
        tenantId,
        vehicleId,
        contactId: vehicle.contactId,
        description,
        kmIn: kmIn != null && !isNaN(kmIn) ? kmIn : null,
        technicianId: user.id,
      },
    });
    if (jc.kmIn != null) {
      await tx.mileageLog.create({
        data: { tenantId, vehicleId, km: jc.kmIn, note: `Job card #${jc.number} check-in` },
      });
    }
    return jc;
  });
  await logAudit({
    action: "jobcard.opened",
    summary: `Opened job card #${jobCard.number} on ${vehicle.model}: ${description}`,
    contactId: vehicle.contactId,
    user,
  });
  revalidatePath("/jobcards");
  redirect(`/jobcards/${jobCard.id}`);
}

/**
 * Claim `qty` units of a part under a row lock: locks the Part FOR UPDATE,
 * computes availability as stockQty minus active reservations, rejects when it
 * can't cover the request (oversell), then decrements atomically. Run inside the
 * SAME transaction that creates the job-card line so the line and the decrement
 * commit together. Two concurrent claims can no longer both read the old stock
 * and both write a clamped absolute value.
 */
async function claimPartStock(
  tx: Prisma.TransactionClient,
  partId: string,
  qty: number,
  tenantId: string,
): Promise<{ ok: true } | { ok: false; available: number; name: string }> {
  // Lock (and fetch) only a LIVE part — a trashed part must not be consumed via a
  // known id. basePrisma transactions aren't soft-delete filtered, so the
  // deletedAt IS NULL predicate is explicit here.
  //
  // And only a part THIS WORKSPACE OWNS. This runs on the bypass client, so
  // authorising the job card said nothing about the part: a forged partId
  // locked, counted and DECREMENTED another tenant's stock. The tenant predicate
  // has to be on the lock, the read, the reservation aggregate and the
  // decrement — a filtered read in front of an unfiltered update is not a
  // boundary, it is a race.
  await tx.$executeRaw`SELECT id FROM "Part" WHERE id = ${partId} AND "deletedAt" IS NULL AND "tenantId" = ${tenantId} FOR UPDATE`;
  const part = await tx.part.findFirst({
    where: { id: partId, deletedAt: null, tenantId },
    select: { name: true, stockQty: true },
  });
  if (!part) return { ok: false, available: 0, name: "part" };
  const agg = await tx.partReservation.aggregate({ where: { partId, status: "active", tenantId }, _sum: { qty: true } });
  const available = part.stockQty - (agg._sum.qty ?? 0);
  if (qty > available) return { ok: false, available: Math.max(0, available), name: part.name };
  const claimed = await tx.part.updateMany({
    where: { id: partId, deletedAt: null, tenantId },
    data: { stockQty: { decrement: qty } },
  });
  if (claimed.count !== 1) return { ok: false, available: 0, name: part.name };
  return { ok: true };
}

export async function addJobCardItem(jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    const description = String(formData.get("description") ?? "").trim();
    if (!description) refuse("Give the line a description.");
    const kind = String(formData.get("kind") ?? "part");
    const partId = String(formData.get("partId") ?? "").trim() || null;
    const unitPriceCents = parseRands(String(formData.get("unitPrice") ?? ""));
    const isPart = Boolean(partId) && kind === "part";
    // Reject invalid quantities instead of silently coercing them to 1 (a negative
    // used to flow through and INCREASE stock). Parts must be WHOLE positive units;
    // labour/other lines may be fractional but must still be positive.
    const qtyRaw = parseFloat(String(formData.get("qty") ?? "1"));
    const qty = isPart
      ? (Number.isInteger(qtyRaw) && qtyRaw > 0 ? qtyRaw : null)
      : (Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : null);
    if (qty == null) throw new ActionRefusal("Enter a valid quantity.");

    // Claim stock (locked, oversell-checked) and create the line in one transaction.
    const tenantId = await actingTenantId();
    const outcome = await basePrisma.$transaction(async (tx) => {
      if (isPart && partId) {
        // The part must belong to this workspace — the job card's authorisation
        // says nothing about a partId that arrived in the same form post.
        const claim = await claimPartStock(tx, partId, qty, tenantId);
        if (!claim.ok) return claim;
      }
      await tx.jobCardItem.create({ data: { tenantId, jobCardId, kind, description, qty, unitPriceCents, partId } });
      return { ok: true as const };
    });
    if (!outcome.ok) throw new ActionRefusal(`Only ${outcome.available} × ${outcome.name} in stock.`);
    revalidatePath(`/jobcards/${jobCardId}`);
    revalidatePath("/parts");
  });
}

export async function deleteJobCardItem(id: string, jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
    const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
    // Scope the child to the authorized job card — a caller with access to THIS
    // job card must not be able to delete another job card's item by id. Delete the
    // line AND restore its stock in ONE transaction so the two can't diverge (the
    // old code did them separately and swallowed the restore's errors). updateMany
    // won't throw if the part is gone, so a missing part doesn't block the delete.
    const tenantId = await actingTenantId();
    const item = await basePrisma.$transaction(async (tx) => {
      const owned = await tx.jobCardItem.findFirst({ where: { id, jobCardId, tenantId } });
      if (!owned) return null;
      await tx.jobCardItem.delete({ where: { id: owned.id } });
      if (owned.partId && owned.kind === "part") {
        const inc = Math.round(owned.qty);
        if (inc > 0) {
          // Restoring stock is a decrement in reverse and needs the same guard:
          // a bare part id here would credit another tenant's stock.
          await tx.part.updateMany({ where: { id: owned.partId, tenantId }, data: { stockQty: { increment: inc } } });
        }
      }
      return owned;
    });
    if (!item) refuse("That line is no longer on this job card.");
    const jobCard = await prisma.jobCard.findUnique({ where: { id: jobCardId } });
    await logAudit({
      action: "jobcard.item_deleted",
      summary: `Removed “${item.description}” from job card #${jobCard?.number ?? "?"} — ${reason}`,
      contactId: jobCard?.contactId,
      user,
    });
    revalidatePath(`/jobcards/${jobCardId}`);
  });
}

export async function setJobCardTechnician(jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    // Authorising the JOB CARD says the caller may edit this job card. It says
    // nothing about the person they named. `User` is a global model, so the
    // posted id used to be stored as-is and a technician from another workspace
    // could be put on this workshop's work — appearing on the job card, its time
    // entries and its customer-facing paperwork. Resolved through tenant
    // membership instead; blank still means unassigned.
    const technician = await resolveAssignableUser(formData.get("technicianId"), "technician");
    await prisma.jobCard.update({ where: { id: jobCardId }, data: { technicianId: technician?.id ?? null } });
    revalidatePath(`/jobcards/${jobCardId}`);
  });
}

// Moving to any workflow stage (or cancelling / reopening). "collected" is
// reserved for completeJobCard, which also creates the service record.
export async function setJobCardStatus(jobCardId: string, status: string) {
  return asActionResult(async () => {
    const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
    const allowed = new Set(STAGE_VALUES.filter((s) => s !== "collected"));
    if (!allowed.has(status)) throw new ActionRefusal("Invalid job card status");
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
  });
}

export async function setJobCardPriority(jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    const priority = String(formData.get("priority") ?? "normal");
    if (!PRIORITY_VALUES.includes(priority)) refuse("Choose a valid priority.");
    await prisma.jobCard.update({ where: { id: jobCardId }, data: { priority } });
    revalidatePath("/jobcards");
    revalidatePath(`/jobcards/${jobCardId}`);
  });
}

export async function setJobCardBay(jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    const bayId = String(formData.get("bayId") ?? "").trim() || null;
    await prisma.jobCard.update({ where: { id: jobCardId }, data: { bayId } });
    revalidatePath(`/jobcards/${jobCardId}`);
  });
}

export async function setJobCardEstimate(jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
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
  });
}

// ── Technician time clock ────────────────────────────────────────────────────
// A technician has at most one running clock at a time. Starting one auto-stops
// any other running entry they left open (on this or another job).
export async function startTimeEntry(jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
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
  });
}

export async function stopTimeEntry(jobCardId: string) {
  return asActionResult(async () => {
    const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
    await prisma.jobCardTimeEntry.updateMany({
      where: { jobCardId, technicianId: user.id, endedAt: null },
      data: { endedAt: new Date() },
    });
    revalidatePath(`/jobcards/${jobCardId}`);
  });
}

export async function deleteTimeEntry(entryId: string, jobCardId: string) {
  return asActionResult(async () => {
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    // Scoped delete: only removes the entry if it belongs to the authorized job card.
    await prisma.jobCardTimeEntry.deleteMany({ where: { id: entryId, jobCardId } });
    revalidatePath(`/jobcards/${jobCardId}`);
  });
}

export async function completeJobCard(jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
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
  });
}

export async function deleteJobCard(id: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireJobCardAccess(id, "jobcards.manage");
    const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
    // Void any live signing request AND soft-delete the job card in one locked
    // transaction, so a trashed job card can't still be signed via a live link.
    const jobCard = await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "JobCard" WHERE id = ${id} FOR UPDATE`;
      await tx.signatureRequest.updateMany({
        where: { jobCardId: id, deletedAt: null, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
        data: { status: "voided" },
      });
      return tx.jobCard.update({
        where: { id },
        data: { deletedAt: new Date(), deleteReason: reason, deletedByName: user.name },
      });
    });
    await logAudit({
      action: "trash.deleted",
      summary: `Moved job card #${jobCard.number} to trash — ${reason}`,
      contactId: jobCard.contactId,
      user,
    });
    revalidatePath("/jobcards");
    return { redirectTo: "/jobcards" };
  });
}

// ── Condition notes & check-out photos (phase 2) ──────────────────────────────
export async function saveConditionNotes(jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    const checkinNotes = String(formData.get("checkinNotes") ?? "").trim() || null;
    const checkoutNotes = String(formData.get("checkoutNotes") ?? "").trim() || null;
    await prisma.jobCard.update({ where: { id: jobCardId }, data: { checkinNotes, checkoutNotes } });
    revalidatePath(`/jobcards/${jobCardId}`);
  });
}

export async function uploadCheckoutPhotos(jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
    const jobCard = await prisma.jobCard.findUniqueOrThrow({ where: { id: jobCardId } });
    const files = formData.getAll("files").filter((f): f is File => typeof f === "object" && (f as File).size > 0);
    // The input is not `required`, and invalid files were skipped silently — so
    // "Photos uploaded" could report saving nothing at all.
    if (files.length === 0) refuse("Choose at least one photo.");
    const accepted = files.filter(
      (file) => file.size <= MAX_PHOTO_BYTES && file.type.startsWith("image/"),
    );
    if (accepted.length === 0) {
      refuse("None of those files could be used — photos must be images under 4 MB.");
    }
    // The TOTAL, not just each file. Twelve files individually under 4 MB is 48 MB,
    // which the framework refuses before this function runs — so without this the
    // per-file limit was the only one enforced and the real ceiling was invisible.
    // checkUploadPayload states the same budget the client resizes against.
    const payload = checkUploadPayload(accepted.slice(0, MAX_PHOTOS).map((file) => file.size));
    if (!payload.ok) refuse(payload.reason);
    const skipped = (files.length - accepted.length) + Math.max(0, accepted.length - MAX_PHOTOS);
    let saved = 0;
    for (const file of accepted.slice(0, MAX_PHOTOS)) {
      const buf = Buffer.from(await file.arrayBuffer());
      const storedName = await saveFile(buf, file.name || "checkout.jpg", file.type, jobCard.tenantId);
      await prisma.document.create({
        data: {
          fileName: `Check-out photo — job card #${jobCard.number} — ${file.name}`,
          storedName,
          mimeType: file.type,
          sizeBytes: file.size,
          contactId: jobCard.contactId,
          jobCardId,
          // The job card owns the row for the same reason it owns the blob above.
          tenantId: jobCard.tenantId,
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
    return { success: photoMessage(saved, skipped) };
  });
}

// ── Inspection checklist (phase 2) ────────────────────────────────────────────
export async function addInspectionItem(jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    const label = String(formData.get("label") ?? "").trim();
    if (!label) refuse("Give the inspection item a label.");
    const status = String(formData.get("status") ?? "ok");
    const max = await prisma.jobCardInspectionItem.aggregate({ where: { jobCardId }, _max: { sortOrder: true } });
    await prisma.jobCardInspectionItem.create({
      data: { jobCardId, label, status, sortOrder: (max._max.sortOrder ?? 0) + 1 },
    });
    revalidatePath(`/jobcards/${jobCardId}`);
  });
}

export async function setInspectionItem(itemId: string, jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    const status = String(formData.get("status") ?? "ok");
    const notes = String(formData.get("notes") ?? "").trim() || null;
    // Scoped update: only touches the item if it belongs to the authorized job card.
    await prisma.jobCardInspectionItem.updateMany({ where: { id: itemId, jobCardId }, data: { status, notes } });
    revalidatePath(`/jobcards/${jobCardId}`);
  });
}

export async function deleteInspectionItem(itemId: string, jobCardId: string) {
  return asActionResult(async () => {
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    await prisma.jobCardInspectionItem.deleteMany({ where: { id: itemId, jobCardId } });
    revalidatePath(`/jobcards/${jobCardId}`);
  });
}

export async function registerInspectionPhoto(
  itemId: string,
  jobCardId: string,
  staged: StagedJobCardPhoto[],
): Promise<ActionResult> {
  const failureLog: { scope: string; context: string; tenantId?: string | null } = {
    scope: "inspection-photo-finalize",
    context: `jobCard=${jobCardId} item=${itemId}`,
  };
  return asActionResult(async () => {
    const tenantId = await actingTenantId();
    failureLog.tenantId = tenantId;
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    const item = await basePrisma.jobCardInspectionItem.findFirst({
      where: { id: itemId, jobCardId, tenantId },
      select: { id: true, tenantId: true, photoStoredName: true },
    });
    if (!item?.tenantId) refuse("That inspection item is no longer available in this workspace.");
    const url = String(staged[0]?.url ?? "").trim();
    if (!url || staged.length !== 1) refuse("Choose one inspection photo.");

    const blob = await assertOwnedBlob(url, item.tenantId);
    if (!blob.contentType.startsWith("image/")) refuse("That file is not an image.");
    if (blob.size <= 0 || blob.size > MAX_PHOTO_BYTES) refuse("That photo is outside the 4 MB limit.");
    if (!blob.pathname.startsWith(`uploads/${item.tenantId}/inspection/${item.id}/`)) {
      refuse("That photo does not belong to this inspection item.");
    }
    await basePrisma.jobCardInspectionItem.updateMany({
      where: { id: item.id, jobCardId, tenantId: item.tenantId },
      data: { photoStoredName: url },
    });
    if (item.photoStoredName && item.photoStoredName !== url) {
      await deleteFile(item.photoStoredName).catch(async (error) => {
        await logError("inspection-photo-cleanup", error, `jobCard=${jobCardId} item=${itemId}`, {
          tenantId: item.tenantId,
          alert: false,
        });
      });
    }
    revalidatePath(`/jobcards/${jobCardId}`);
    return { success: "Inspection photo uploaded" };
  }, failureLog);
}

export async function uploadInspectionPhoto(itemId: string, jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    // Verify the item belongs to the authorized job card BEFORE saving a file, so a
    // wrong item id can't attach a photo to another job card's inspection (or leave
    // an orphaned blob).
    const owned = await prisma.jobCardInspectionItem.findFirst({ where: { id: itemId, jobCardId }, select: { id: true, tenantId: true } });
    if (!owned) refuse("That item is not on this job card — reload the page.");
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) refuse("Choose a photo to upload.");
    // Silently discarding the upload and reporting success means the photo
    // never arrives and nobody is told — the same failure as the delivery
    // paperwork in the previous batch.
    if (file.size > 4 * 1024 * 1024) refuse("That photo is larger than 4 MB.");
    if (!file.type.startsWith("image/")) refuse("That file is not an image.");
    const buf = Buffer.from(await file.arrayBuffer());
    // The inspection ITEM owns its photo. That row was already fetched to prove it
    // belongs to the authorized job card, so its owner comes free and is the same
    // one the composite (tenantId, jobCardId) key holds it to.
    const storedName = await saveFile(buf, file.name || "inspection.jpg", file.type, owned.tenantId);
    await prisma.jobCardInspectionItem.update({ where: { id: itemId }, data: { photoStoredName: storedName } });
    revalidatePath(`/jobcards/${jobCardId}`);
  });
}

// ── Additional-work approval (phase 2) ────────────────────────────────────────
export async function requestAdditionalWork(jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
    const description = String(formData.get("description") ?? "").trim();
    if (!description) refuse("Describe the additional work you are requesting.");
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
  });
}

export async function decideApproval(approvalId: string, jobCardId: string, decision: "approved" | "declined", formData: FormData) {
  return asActionResult(async () => {
    const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
    const decidedVia = String(formData.get("decidedVia") ?? "phone");
    const notes = String(formData.get("notes") ?? "").trim() || null;
    // Scope to the authorized job card so a caller can't decide another job's approval.
    const owned = await prisma.jobCardApproval.findFirst({ where: { id: approvalId, jobCardId }, select: { id: true } });
    if (!owned) refuse("That item is not on this job card — reload the page.");
    const approval = await prisma.jobCardApproval.update({
      where: { id: approvalId },
      data: { status: decision, decidedVia, decidedAt: new Date(), notes },
      include: { jobCard: { select: { number: true, contactId: true } } },
    });
    await logAudit({ action: "jobcard.approval_decided", summary: `Additional work ${decision} (${decidedVia}) on job card #${approval.jobCard.number}: ${approval.description}`, contactId: approval.jobCard.contactId, user });
    revalidatePath(`/jobcards/${jobCardId}`);
  });
}

export async function deleteApproval(approvalId: string, jobCardId: string) {
  return asActionResult(async () => {
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    await prisma.jobCardApproval.deleteMany({ where: { id: approvalId, jobCardId } });
    revalidatePath(`/jobcards/${jobCardId}`);
  });
}

// ── Subcontracting (phase 3) ──────────────────────────────────────────────────
export async function saveSubcontract(jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    const isSubcontracted = formData.get("isSubcontracted") === "on";
    const subcontractor = String(formData.get("subcontractor") ?? "").trim() || null;
    const subCostCents = parseRands(String(formData.get("subCost") ?? ""));
    await prisma.jobCard.update({ where: { id: jobCardId }, data: { isSubcontracted, subcontractor, subCostCents } });
    revalidatePath(`/jobcards/${jobCardId}`);
  });
}

// ── Part reservations (phase 3) ───────────────────────────────────────────────
// A reservation earmarks stock without consuming it. Available = stockQty minus
// active reservations. Consuming turns a reservation into a job-card part line
// and decrements stock.
export async function reservePart(jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireJobCardAccess(jobCardId, "jobcards.manage");
    const partId = String(formData.get("partId") ?? "").trim();
    if (!partId) refuse("Choose a part to reserve.");
    const qty = Math.max(1, parseInt(String(formData.get("qty") ?? "1"), 10) || 1);
    // The SIBLING of the forged-partId decrement #459 closed in claimPartStock:
    // same forged id, same form post, different entry point. Reserving does not
    // move stock, so it left no decrement to notice — it just earmarked another
    // workshop's parts, and their available quantity fell with nothing on their
    // side to explain it.
    //
    // This one runs on the SCOPED client rather than the bypass one, which is
    // exactly why it stayed open: the db.ts guard returns its args UNTOUCHED
    // while enforcement is dormant, so "scoped" scopes nothing in any environment
    // we run, and raw SQL is never rewritten by the extension at all. So the same
    // shape claimPartStock uses, explicitly — tenant predicate on the lock, on the
    // read, on the reservation aggregate, and on the write.
    //
    // The write is a `create`, so its predicate is the STAMP. That is not a weaker
    // check than claimPartStock's count-checked updateMany: a create cannot
    // silently match zero rows, and stamping is what ARMS the two composite foreign
    // keys PartReservation already has — (tenantId, partId) → Part(tenantId, id)
    // and (tenantId, jobCardId) → JobCard(tenantId, id). Leaving tenantId NULL,
    // which is what the unstamped create did, satisfies both trivially (MATCH
    // SIMPLE), so the row that crossed the boundary was also the row the database
    // had been told not to check.
    const tenantId = await actingTenantId();
    // Never reserve more than is actually available. Lock the part row so two
    // concurrent reservations can't both pass the availability check (oversell).
    const outcome = await prisma.$transaction(async (tx) => {
      // Lock + fetch a LIVE part only — a trashed part must not be reservable by id.
      await tx.$executeRaw`SELECT id FROM "Part" WHERE id = ${partId} AND "deletedAt" IS NULL AND "tenantId" = ${tenantId} FOR UPDATE`;
      const part = await tx.part.findFirst({ where: { id: partId, deletedAt: null, tenantId }, select: { name: true, stockQty: true } });
      if (!part) return { ok: false as const };
      const agg = await tx.partReservation.aggregate({ where: { partId, status: "active", tenantId }, _sum: { qty: true } });
      const reserved = agg._sum.qty ?? 0;
      if (reserved + qty > part.stockQty) {
        return { ok: false as const, over: true, available: Math.max(0, part.stockQty - reserved), name: part.name };
      }
      await tx.partReservation.create({ data: { jobCardId, partId, qty, tenantId } });
      return { ok: true as const, name: part.name };
    });
    if (!outcome.ok) {
      if (outcome.over) throw new ActionRefusal(`Only ${outcome.available} × ${outcome.name} available to reserve.`);
      refuse("That part is no longer available to reserve.");
    }
    const jobCard = await prisma.jobCard.findUnique({ where: { id: jobCardId }, select: { number: true, contactId: true } });
    await logAudit({ action: "jobcard.part_reserved", summary: `Reserved ${qty}× ${outcome.name} for job card #${jobCard?.number ?? "?"}`, contactId: jobCard?.contactId, user });
    revalidatePath(`/jobcards/${jobCardId}`);
    revalidatePath("/parts");
  });
}

export async function releaseReservation(reservationId: string, jobCardId: string) {
  return asActionResult(async () => {
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    // Require status "active" so a consumed reservation can't be flipped back to
    // released (which would leave its stock decrement + job-card line in place and
    // let it be consumed again).
    const released = await prisma.partReservation.updateMany({
      where: { id: reservationId, jobCardId, status: "active" },
      data: { status: "released" },
    });
    // count === 0 means the reservation was already consumed or released, or
    // belongs to another job card — nothing changed, so "Reservation released"
    // would be a plain untruth.
    if (released.count === 0) {
      refuse("That reservation is no longer active — reload the page.");
    }
    revalidatePath(`/jobcards/${jobCardId}`);
    revalidatePath("/parts");
  });
}

export async function consumeReservation(reservationId: string, jobCardId: string) {
  return asActionResult(async () => {
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    // Lock the PART row FIRST (same ordering as claimPartStock), THEN claim the
    // reservation and decrement — all in one transaction. The old code flipped the
    // reservation active→consumed without ever locking the part, so a concurrent
    // direct stock claim could lock the part, no longer see this (now-consumed)
    // reservation in the availability calc, claim the "freed" stock, and both paths
    // decrement into negative stock. Locking the part serializes the two.
    const tenantId = await actingTenantId();
    const outcome = await prisma.$transaction(async (tx) => {
      const reservation = await tx.partReservation.findUnique({ where: { id: reservationId } });
      if (!reservation || reservation.jobCardId !== jobCardId || reservation.status !== "active") {
        return { ok: false as const, why: "stale" as const };
      }
      // The same tenant predicate claimPartStock puts on its lock and read. The
      // reservation is already bound to the authorised job card, but its partId is
      // a bare column — and a reservation planted before reservePart stamped and
      // scoped (above) can still point at another workspace's part.
      await tx.$executeRaw`SELECT id FROM "Part" WHERE id = ${reservation.partId} AND "deletedAt" IS NULL AND "tenantId" = ${tenantId} FOR UPDATE`;
      const part = await tx.part.findFirst({ where: { id: reservation.partId, deletedAt: null, tenantId }, select: { name: true, priceCents: true, stockQty: true } });
      if (!part) return { ok: false as const, why: "part-gone" as const };
      // Claim the reservation FIRST, under the part lock. Only the request that
      // flips active→consumed proceeds — a second waiter (whose reservation was
      // already consumed) exits harmlessly instead of throwing a false shortage
      // against the now-reduced stock. Throwing after the claim rolls it back.
      const claimed = await tx.partReservation.updateMany({
        where: { id: reservationId, jobCardId, status: "active" },
        data: { status: "consumed" },
      });
      if (claimed.count !== 1) return { ok: false as const, why: "stale" as const };
      if (part.stockQty < reservation.qty) {
        // Throw (not return) so the reservation claim rolls back — otherwise it
        // would commit as "consumed" with no job-card line or stock decrement.
        throw new ActionRefusal(`Only ${Math.max(0, part.stockQty)} × ${part.name} physically in stock — can't consume ${reservation.qty}.`);
      }
      await tx.jobCardItem.create({
        data: { tenantId, jobCardId, kind: "part", description: part.name, qty: reservation.qty, unitPriceCents: part.priceCents, partId: reservation.partId },
      });
      const decremented = await tx.part.updateMany({
        where: { id: reservation.partId, tenantId },
        data: { stockQty: { decrement: reservation.qty } },
      });
      // The count check claimPartStock has and this path did not. updateMany does
      // not throw on a zero-row match, so a part this workspace does not own
      // committed the reservation as consumed and filed a job-card line for stock
      // that never moved. Throw so all three roll back together.
      if (decremented.count !== 1) {
        throw new ActionRefusal("That part no longer exists — the reservation cannot be consumed.");
      }
      return { ok: true as const };
    });
    // The transaction's verdict was previously DISCARDED, so a stale, already
    // consumed, mismatched or deleted-part reservation still toasted "Part
    // consumed" — telling the workshop stock had moved when it had not.
    if (!outcome.ok) {
      refuse(
        outcome.why === "part-gone"
          ? "That part no longer exists — the reservation cannot be consumed."
          : "That reservation is no longer active — reload the page.",
      );
    }
    revalidatePath(`/jobcards/${jobCardId}`);
    revalidatePath("/parts");
  });
}

// ── Warranty recovery & comebacks (phase 4) ───────────────────────────────────
export async function setJobWarranty(jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    const underWarranty = formData.get("underWarranty") === "on";
    const warrantyRecoveredCents = parseRands(String(formData.get("warrantyRecovered") ?? ""));
    await prisma.jobCard.update({ where: { id: jobCardId }, data: { underWarranty, warrantyRecoveredCents } });
    revalidatePath(`/jobcards/${jobCardId}`);
  });
}

export async function setComeback(jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    const comebackOfId = String(formData.get("comebackOfId") ?? "").trim() || null;
    await prisma.jobCard.update({ where: { id: jobCardId }, data: { comebackOfId } });
    revalidatePath(`/jobcards/${jobCardId}`);
  });
}

// ── Service packages (phase 3) ────────────────────────────────────────────────
export async function applyServicePackage(jobCardId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    const packageId = String(formData.get("packageId") ?? "").trim();
    if (!packageId) refuse("Choose a service package.");
    const pkg = await prisma.servicePackage.findUnique({ where: { id: packageId }, include: { items: true } });
    if (!pkg) refuse("That service package no longer exists.");
    const tenantId = await actingTenantId();
    // Apply every line + its stock claim in ONE transaction. Each part is claimed
    // under a row lock with an availability check (stock minus active reservations),
    // so the package can't oversell; insufficient stock on ANY part rolls the whole
    // package back instead of leaving it half-applied or clamping stock to zero.
    const outcome = await basePrisma.$transaction(async (tx) => {
      for (const item of pkg.items) {
        if (item.partId && item.kind === "part") {
          const dec = Math.round(item.qty);
          if (dec > 0) {
            const claim = await claimPartStock(tx, item.partId, dec, tenantId);
            if (!claim.ok) return claim;
          }
        }
        await tx.jobCardItem.create({
          data: { tenantId, jobCardId, kind: item.kind, description: item.description, qty: item.qty, unitPriceCents: item.unitPriceCents, partId: item.partId },
        });
      }
      return { ok: true as const };
    });
    if (!outcome.ok) throw new ActionRefusal(`Not enough stock to apply this package — only ${outcome.available} × ${outcome.name} available.`);
    revalidatePath(`/jobcards/${jobCardId}`);
    revalidatePath("/parts");
  });
}
