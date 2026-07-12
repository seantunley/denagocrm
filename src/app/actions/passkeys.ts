"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

/** Remove one of the current user's own passkeys. */
export async function removePasskey(id: string) {
  const user = await requireUser();
  // Scope the delete to the caller so nobody can remove another user's key.
  const passkey = await prisma.passkey.findFirst({
    where: { id, userId: user.id },
    select: { id: true, nickname: true },
  });
  if (!passkey) return;
  await prisma.passkey.delete({ where: { id: passkey.id } });
  await logAudit({
    action: "passkey.removed",
    summary: `Removed a passkey${passkey.nickname ? ` (${passkey.nickname})` : ""}`,
    user,
  });
  revalidatePath("/settings");
}

/** Rename one of the current user's own passkeys. */
export async function renamePasskey(id: string, formData: FormData) {
  const user = await requireUser();
  const nickname = String(formData.get("nickname") ?? "").trim().slice(0, 60) || null;
  const passkey = await prisma.passkey.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  });
  if (!passkey) return;
  await prisma.passkey.update({ where: { id: passkey.id }, data: { nickname } });
  revalidatePath("/settings");
}
