"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { putSetting, getSetting } from "@/lib/settings";
import { getBotFaqs } from "@/lib/botAi";
import { logAudit } from "@/lib/audit";

export async function saveBotSettings(formData: FormData) {
  const owner = await requireOwner();
  const enabled = formData.get("enabled") === "on";
  const aiEnabled = formData.get("aiEnabled") === "on";
  const flowEnabled = formData.get("flowEnabled") === "on";
  await putSetting("BOT_ENABLED", enabled ? "true" : "false");
  await putSetting("BOT_AI_ENABLED", aiEnabled ? "true" : "false");
  await putSetting("BOT_FLOW_ENABLED", flowEnabled ? "true" : "false");
  await putSetting("BOT_AI_BRIEF", String(formData.get("brief") ?? "").trim());
  await putSetting(
    "BOT_HOURS",
    `${String(formData.get("start") ?? "08:00")}-${String(formData.get("end") ?? "17:00")}`
  );
  await putSetting("BOT_DAYS", formData.getAll("days").map(String).join(",") || "1,2,3,4,5");
  await putSetting("BOT_AFTERHOURS_MSG", String(formData.get("afterhours") ?? "").trim());
  // Whisper key for voice-note transcription — only overwrite if provided
  const whisper = String(formData.get("whisperKey") ?? "").trim();
  if (whisper && !whisper.startsWith("•")) await putSetting("OPENAI_API_KEY", whisper);
  await logAudit({
    action: "bot.settings",
    summary: `WhatsApp bot ${enabled ? "enabled" : "disabled"}${aiEnabled ? " (AI assistant on)" : ""}`,
    userName: owner.name,
  });
  revalidatePath("/settings");
}

export async function addFaq(formData: FormData) {
  await requireOwner();
  const question = String(formData.get("question") ?? "").trim();
  const answer = String(formData.get("answer") ?? "").trim();
  const handoff = formData.get("handoff") === "on";
  if (!question || !answer) return;
  const faqs = await getBotFaqs();
  faqs.push({ id: crypto.randomUUID(), question, answer, handoff });
  await putSetting("BOT_FAQS", JSON.stringify(faqs));
  revalidatePath("/settings");
}

export async function deleteFaq(id: string) {
  await requireOwner();
  const faqs = (await getBotFaqs()).filter((f) => f.id !== id);
  await putSetting("BOT_FAQS", JSON.stringify(faqs));
  revalidatePath("/settings");
}

/** Whether a Whisper key is stored (for the settings UI, without revealing it). */
export async function whisperConfigured(): Promise<boolean> {
  return Boolean(await getSetting("OPENAI_API_KEY"));
}
