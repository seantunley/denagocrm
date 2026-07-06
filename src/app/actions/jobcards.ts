"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addMonths } from "date-fns";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { parseRands } from "@/lib/format";

export async function createJobCard(formData: FormData) {
  const user = await requireUser();
  const vehicleId = String(formData.get("vehicleId") ?? "");
  const description = String(formData.get("description") ?? "").trim();
  if (!vehicleId || !description) throw new Error("Vehicle and description are required");

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
  await requireUser();
  const description = String(formData.get("description") ?? "").trim();
  if (!description) return;
  const qty = parseFloat(String(formData.get("qty") ?? "1")) || 1;
  await prisma.jobCardItem.create({
    data: {
      jobCardId,
      kind: String(formData.get("kind") ?? "part"),
      description,
      qty,
      unitPriceCents: parseRands(String(formData.get("unitPrice") ?? "")),
    },
  });
  revalidatePath(`/jobcards/${jobCardId}`);
}

export async function deleteJobCardItem(id: string, jobCardId: string) {
  await requireUser();
  await prisma.jobCardItem.delete({ where: { id } });
  revalidatePath(`/jobcards/${jobCardId}`);
}

export async function setJobCardStatus(jobCardId: string, status: string) {
  await requireUser();
  await prisma.jobCard.update({
    where: { id: jobCardId },
    data: { status, completedAt: status === "completed" ? new Date() : null },
  });
  revalidatePath("/jobcards");
  revalidatePath(`/jobcards/${jobCardId}`);
}

/**
 * Completes a job card and writes the service record in one go —
 * next-due defaults come from the vehicle's service intervals.
 */
export async function completeJobCard(jobCardId: string, formData: FormData) {
  const user = await requireUser();
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
      data: { status: "completed", completedAt: new Date() },
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
  revalidatePath("/jobcards");
  revalidatePath(`/jobcards/${jobCardId}`);
  revalidatePath(`/vehicles/${jobCard.vehicleId}`);
  revalidatePath("/vehicles");
}

export async function deleteJobCard(id: string) {
  await requireUser();
  await prisma.jobCard.delete({ where: { id } });
  revalidatePath("/jobcards");
  redirect("/jobcards");
}
