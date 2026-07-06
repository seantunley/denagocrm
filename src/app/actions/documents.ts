"use server";

import { revalidatePath } from "next/cache";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

const UPLOAD_DIR = path.join(process.cwd(), "storage", "uploads");
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

  const ext = path.extname(file.name).slice(0, 12);
  const storedName = crypto.randomUUID() + ext;
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(path.join(UPLOAD_DIR, storedName), buffer);

  await prisma.document.create({
    data: {
      fileName: file.name,
      storedName,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      contactId: str("contactId"),
      vehicleId: str("vehicleId"),
      jobCardId: str("jobCardId"),
      uploadedById: user.id,
    },
  });
  revalidatePath(String(formData.get("revalidate") ?? "/"));
}

export async function deleteDocument(id: string, revalidate: string) {
  await requireUser();
  const doc = await prisma.document.delete({ where: { id } });
  await fs.unlink(path.join(UPLOAD_DIR, doc.storedName)).catch(() => {});
  revalidatePath(revalidate);
}
