"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export async function addCommunication(formData: FormData) {
  const user = await requireUser();
  const str = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return;

  const occurredAtRaw = str("occurredAt");
  await prisma.communication.create({
    data: {
      type: str("type") ?? "note",
      direction: str("direction"),
      subject: str("subject"),
      body,
      occurredAt: occurredAtRaw ? new Date(occurredAtRaw) : new Date(),
      contactId: str("contactId"),
      leadId: str("leadId"),
      userId: user.id,
    },
  });
  revalidatePath(String(formData.get("revalidate") ?? "/"));
}

export async function deleteCommunication(id: string, path: string) {
  await requireUser();
  await prisma.communication.delete({ where: { id } });
  revalidatePath(path);
}
