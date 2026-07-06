"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { saveFile } from "@/lib/storage";

const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

export async function uploadDocument(formData: FormData) {
  const user = await requireUser();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return;
  if (file.size > MAX_SIZE) throw new Error("File exceeds 25 MB limit");

  const str = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };

  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || "application/octet-stream";
  const storedName = await saveFile(buffer, file.name, mimeType);

  const doc = await prisma.document.create({
    data: {
      fileName: file.name,
      storedName,
      mimeType,
      sizeBytes: file.size,
      contactId: str("contactId"),
      vehicleId: str("vehicleId"),
      jobCardId: str("jobCardId"),
      uploadedById: user.id,
    },
    include: { vehicle: true, jobCard: true },
  });
  await logAudit({
    action: "document.uploaded",
    summary: `Uploaded document “${file.name}”`,
    contactId: doc.contactId ?? doc.vehicle?.contactId ?? doc.jobCard?.contactId,
    user,
  });
  revalidatePath(String(formData.get("revalidate") ?? "/"));
}

export async function deleteDocument(id: string, revalidate: string, formData: FormData) {
  const user = await requireUser();
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  // soft delete: the stored file is kept until the trash purge
  const doc = await softDeleteRecord("document", id, reason, user.name);
  await logAudit({
    action: "trash.deleted",
    summary: `Moved document “${doc.fileName}” to trash — ${reason}`,
    contactId: doc.contactId,
    user,
  });
  revalidatePath(revalidate);
}
