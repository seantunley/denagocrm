"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCrmOrWorkshop } from "@/lib/auth";

export async function addCommunication(formData: FormData) {
  const user = await requireCrmOrWorkshop();
  const str = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  const body = String(formData.get("body") ?? "").trim();
  const file = formData.get("image");
  const hasFile =
    file && typeof file === "object" && (file as File).size > 0 && (file as File).size <= 4 * 1024 * 1024;
  if (!body && !hasFile) return;

  let attachmentUrl: string | null = null;
  if (hasFile && (file as File).type.startsWith("image/")) {
    const { saveFile } = await import("@/lib/storage");
    const f = file as File;
    attachmentUrl = await saveFile(Buffer.from(await f.arrayBuffer()), f.name || "note.png", f.type);
  }

  const occurredAtRaw = str("occurredAt");
  await prisma.communication.create({
    data: {
      type: str("type") ?? "note",
      direction: str("direction"),
      subject: str("subject"),
      body: body || "🖼 Image",
      attachmentUrl,
      attachmentType: attachmentUrl ? "image" : null,
      occurredAt: occurredAtRaw ? new Date(occurredAtRaw) : new Date(),
      contactId: str("contactId"),
      leadId: str("leadId"),
      userId: user.id,
    },
  });
  revalidatePath(String(formData.get("revalidate") ?? "/"));
}

export async function deleteCommunication(id: string, path: string, formData: FormData) {
  const user = await requireCrmOrWorkshop();
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const comm = await prisma.communication.delete({ where: { id } });
  const { logAudit } = await import("@/lib/audit");
  await logAudit({
    action: "communication.deleted",
    summary: `Deleted ${comm.type} entry (“${comm.body.slice(0, 80)}${comm.body.length > 80 ? "…" : ""}”) — ${reason}`,
    contactId: comm.contactId,
    leadId: comm.leadId,
    user,
  });
  revalidatePath(path);
}
