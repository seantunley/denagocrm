import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { apiAuthErrorResponse, requireApiUser } from "@/lib/auth";
import { actingTenantId } from "@/lib/actingTenant";
import { prisma } from "@/lib/db";
import { logError } from "@/lib/errorLog";
import { createLead, updateLead } from "@/app/actions/leads";
import { createContact, updateContact } from "@/app/actions/contacts";
import { markDelivered, uploadDeliveryPhotos } from "@/app/actions/fulfilment";
import {
  saveConditionNotes,
  setInspectionItem,
  uploadInspectionPhoto,
  uploadJobCardPhotos,
  uploadCheckoutPhotos,
} from "@/app/actions/jobcards";

export const runtime = "nodejs";

const operationSchema = z.object({
  type: z.enum([
    "lead.create", "lead.update", "contact.create", "contact.update",
    "jobcard.notes", "jobcard.inspection", "jobcard.photo", "inspection.photo",
    "delivery.complete", "delivery.photo",
  ]),
  recordId: z.string().min(1).max(100).optional(),
  parentId: z.string().min(1).max(100).optional(),
  baseVersion: z.string().datetime().optional(),
});

type Operation = z.infer<typeof operationSchema>;

async function currentVersion(operation: Operation): Promise<Date | null> {
  if (!operation.recordId || !operation.baseVersion) return null;
  if (operation.type === "lead.update") {
    return (await prisma.lead.findUnique({ where: { id: operation.recordId }, select: { updatedAt: true } }))?.updatedAt ?? null;
  }
  if (operation.type === "contact.update") {
    return (await prisma.contact.findUnique({ where: { id: operation.recordId }, select: { updatedAt: true } }))?.updatedAt ?? null;
  }
  if (operation.type === "jobcard.notes" || operation.type === "jobcard.inspection") {
    const id = operation.type === "jobcard.inspection" ? operation.parentId : operation.recordId;
    if (!id) return null;
    return (await prisma.jobCard.findUnique({ where: { id }, select: { updatedAt: true } }))?.updatedAt ?? null;
  }
  if (operation.type === "delivery.complete") {
    return (await prisma.quote.findUnique({ where: { id: operation.recordId }, select: { updatedAt: true } }))?.updatedAt ?? null;
  }
  return null;
}

async function execute(operation: Operation, formData: FormData) {
  switch (operation.type) {
    case "lead.create":
      return createLead(formData);
    case "lead.update":
      if (!operation.recordId) throw new Error("Missing lead id.");
      return updateLead(operation.recordId, formData);
    case "contact.create":
      return createContact(formData);
    case "contact.update":
      if (!operation.recordId) throw new Error("Missing contact id.");
      return updateContact(operation.recordId, formData);
    case "jobcard.notes":
      if (!operation.recordId) throw new Error("Missing job card id.");
      return saveConditionNotes(operation.recordId, formData);
    case "jobcard.inspection":
      if (!operation.recordId || !operation.parentId) throw new Error("Missing inspection identity.");
      return setInspectionItem(operation.recordId, operation.parentId, formData);
    case "inspection.photo":
      if (!operation.recordId || !operation.parentId) throw new Error("Missing inspection identity.");
      return uploadInspectionPhoto(operation.recordId, operation.parentId, formData);
    case "jobcard.photo":
      if (!operation.recordId) throw new Error("Missing job card id.");
      return String(formData.get("category")) === "checkout"
        ? uploadCheckoutPhotos(operation.recordId, formData)
        : uploadJobCardPhotos(operation.recordId, formData);
    case "delivery.complete":
      if (!operation.recordId) throw new Error("Missing delivery id.");
      return markDelivered(operation.recordId, formData);
    case "delivery.photo":
      if (!operation.recordId) throw new Error("Missing delivery id.");
      return uploadDeliveryPhotos(operation.recordId, formData);
  }
}

export async function POST(request: Request) {
  let tenantId: string | null = null;
  let mutationId = "unknown";
  try {
    const user = await requireApiUser();
    tenantId = await actingTenantId();
    const formData = await request.formData();
    mutationId = String(formData.get("id") ?? "");
    const claimedTenantId = String(formData.get("tenantId") ?? "");
    const claimedUserId = String(formData.get("userId") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(mutationId)) {
      return NextResponse.json({ error: "Invalid offline mutation id." }, { status: 400 });
    }
    if (claimedTenantId !== tenantId || claimedUserId !== user.id) {
      return NextResponse.json({ error: "This queued change belongs to another user or workspace." }, { status: 403 });
    }
    const parsed = operationSchema.safeParse(JSON.parse(String(formData.get("operation") ?? "{}")));
    if (!parsed.success) return NextResponse.json({ error: "Invalid offline operation." }, { status: 400 });
    const operation = parsed.data;
    formData.delete("id");
    formData.delete("tenantId");
    formData.delete("userId");
    formData.delete("operation");

    try {
      await prisma.offlineMutationReceipt.create({
        data: { id: mutationId, tenantId, userId: user.id, operation: operation.type },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      const previous = await prisma.offlineMutationReceipt.findUnique({ where: { id: mutationId } });
      if (!previous || previous.tenantId !== tenantId || previous.userId !== user.id) {
        return NextResponse.json({ error: "Offline mutation identity collision." }, { status: 409 });
      }
      if (previous.status === "completed") return NextResponse.json(previous.result ?? { success: "Already synchronised" });
      return NextResponse.json({ error: previous.status === "rejected" ? "This offline change was previously rejected." : "This offline change is already being processed." }, { status: 409 });
    }

    const version = await currentVersion(operation);
    if (version && operation.baseVersion && version.toISOString() !== operation.baseVersion) {
      const result = { error: "This record changed while the device was offline. Review the latest version before applying your change.", conflict: true };
      await prisma.offlineMutationReceipt.update({
        where: { id: mutationId },
        data: { status: "rejected", result, completedAt: new Date() },
      });
      return NextResponse.json(result, { status: 409 });
    }

    const result = (await execute(operation, formData)) ?? {};
    const rejected = typeof result === "object" && result !== null && "error" in result && Boolean(result.error);
    await prisma.offlineMutationReceipt.update({
      where: { id: mutationId },
      data: { status: rejected ? "rejected" : "completed", result: result as Prisma.InputJsonValue, completedAt: new Date() },
    });
    return NextResponse.json(result, { status: rejected ? 400 : 200 });
  } catch (error) {
    await logError("offline-sync", error, `mutation=${mutationId}`, { tenantId, alert: false });
    return apiAuthErrorResponse(error) ?? NextResponse.json(
      { error: "Offline synchronization failed and was recorded in Settings → System Log." },
      { status: 500 },
    );
  }
}
