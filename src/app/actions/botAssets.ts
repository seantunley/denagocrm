"use server";

import { requireOwner } from "@/lib/auth";
import { saveFile } from "@/lib/storage";

const MAX_BOT_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Chatbot assets are owned by the chatbot workspace, not Marketing campaigns.
 * Keeping this owner-gated avoids the historical campaigns.manage/module coupling
 * while preserving the same bounded image-only upload contract.
 */
export async function uploadBotAsset(formData: FormData): Promise<string | null> {
  await requireOwner();
  const value = formData.get("file");
  if (!(value instanceof File)) return null;
  if (!value.type.startsWith("image/") || value.size <= 0 || value.size > MAX_BOT_IMAGE_BYTES) return null;
  const bytes = Buffer.from(await value.arrayBuffer());
  return saveFile(bytes, value.name || "chatbot-image", value.type);
}
