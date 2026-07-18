"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { generateLinkCode } from "@/lib/telegramMiniApp";
import { logAudit } from "@/lib/audit";

const LINK_CODE_TTL_MINUTES = 10;

/** Mint a fresh one-time code (valid 10 min) the user will type into the Mini App. */
export async function generateTelegramLinkCode(): Promise<{ code: string; expiresAt: string }> {
  const user = await requireUser();
  const code = generateLinkCode();
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60 * 1000);
  await prisma.user.update({
    where: { id: user.id },
    data: { telegramLinkCode: code, telegramLinkExpires: expiresAt },
  });
  await logAudit({ action: "auth.telegram_link_code", summary: "Generated a Telegram Mini App link code", userName: user.name });
  revalidatePath("/settings/telegram");
  return { code, expiresAt: expiresAt.toISOString() };
}

export async function unlinkTelegram(): Promise<void> {
  const user = await requireUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { telegramUserId: null, telegramLinkCode: null, telegramLinkExpires: null },
  });
  await logAudit({ action: "auth.telegram_unlinked", summary: "Unlinked their Telegram account", userName: user.name });
  revalidatePath("/settings/telegram");
}
