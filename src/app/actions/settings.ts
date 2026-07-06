"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

// ---- Pipeline stages ----

export async function createStage(formData: FormData) {
  await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const max = await prisma.pipelineStage.aggregate({ _max: { order: true } });
  await prisma.pipelineStage.create({
    data: {
      name,
      color: String(formData.get("color") ?? "#64748b"),
      order: (max._max.order ?? -1) + 1,
    },
  });
  revalidatePath("/settings");
  revalidatePath("/leads");
}

export async function renameStage(id: string, formData: FormData) {
  await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  await prisma.pipelineStage.update({
    where: { id },
    data: { name, color: String(formData.get("color") ?? "#64748b") },
  });
  revalidatePath("/settings");
  revalidatePath("/leads");
}

export async function moveStage(id: string, direction: "up" | "down") {
  await requireUser();
  const stages = await prisma.pipelineStage.findMany({ orderBy: { order: "asc" } });
  const idx = stages.findIndex((s) => s.id === id);
  const swapWith = direction === "up" ? idx - 1 : idx + 1;
  if (idx < 0 || swapWith < 0 || swapWith >= stages.length) return;
  await prisma.$transaction([
    prisma.pipelineStage.update({
      where: { id: stages[idx].id },
      data: { order: stages[swapWith].order },
    }),
    prisma.pipelineStage.update({
      where: { id: stages[swapWith].id },
      data: { order: stages[idx].order },
    }),
  ]);
  revalidatePath("/settings");
  revalidatePath("/leads");
}

export async function deleteStage(id: string): Promise<void> {
  await requireUser();
  const count = await prisma.lead.count({ where: { stageId: id } });
  if (count > 0) return; // stage still holds leads — refuse silently
  await prisma.pipelineStage.delete({ where: { id } });
  revalidatePath("/settings");
  revalidatePath("/leads");
}

// ---- Users ----

export type FormState = { error?: string; ok?: string };

export async function createUser(
  _prev: FormState | undefined,
  formData: FormData
): Promise<FormState> {
  await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!name || !email || password.length < 8) {
    return { error: "Name, email and a password of at least 8 characters are required." };
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return { error: "A user with that email already exists." };
  await prisma.user.create({
    data: { name, email, passwordHash: await bcrypt.hash(password, 10) },
  });
  revalidatePath("/settings");
  return { ok: `${name} added to the team.` };
}

export async function changeOwnPassword(
  _prev: FormState | undefined,
  formData: FormData
): Promise<FormState> {
  const user = await requireUser();
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  if (next.length < 8) return { error: "New password must be at least 8 characters." };
  if (!(await bcrypt.compare(current, user.passwordHash))) {
    return { error: "Current password is incorrect." };
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(next, 10) },
  });
  revalidatePath("/settings");
  return { ok: "Password updated." };
}

// ---- Integration settings ----

export async function saveSetting(formData: FormData) {
  await requireUser();
  const key = String(formData.get("key") ?? "");
  const value = String(formData.get("value") ?? "").trim();
  if (!key) return;
  await prisma.appSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
  revalidatePath("/settings");
}

export async function regenerateSetting(key: string) {
  await requireUser();
  const value = crypto.randomBytes(24).toString("hex");
  await prisma.appSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
  revalidatePath("/settings");
}
