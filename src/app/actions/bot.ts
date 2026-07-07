"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { putSetting } from "@/lib/settings";
import { getBotRules } from "@/lib/bot";
import { logAudit } from "@/lib/audit";

export async function saveBotSettings(formData: FormData) {
  const owner = await requireOwner();
  const enabled = formData.get("enabled") === "on";
  await putSetting("BOT_ENABLED", enabled ? "true" : "false");
  await putSetting(
    "BOT_HOURS",
    `${String(formData.get("start") ?? "08:00")}-${String(formData.get("end") ?? "17:00")}`
  );
  await putSetting("BOT_DAYS", formData.getAll("days").map(String).join(",") || "1,2,3,4,5");
  await putSetting("BOT_AFTERHOURS_MSG", String(formData.get("afterhours") ?? "").trim());
  await logAudit({
    action: "bot.settings",
    summary: `WhatsApp bot ${enabled ? "enabled" : "disabled"}`,
    userName: owner.name,
  });
  revalidatePath("/settings");
}

export async function addBotRule(formData: FormData) {
  await requireOwner();
  const keywords = String(formData.get("keywords") ?? "").trim();
  const reply = String(formData.get("reply") ?? "").trim();
  if (!keywords || !reply) return;
  const rules = await getBotRules();
  rules.push({ id: crypto.randomUUID(), keywords, reply });
  await putSetting("BOT_RULES", JSON.stringify(rules));
  revalidatePath("/settings");
}

export async function deleteBotRule(id: string) {
  await requireOwner();
  const rules = (await getBotRules()).filter((r) => r.id !== id);
  await putSetting("BOT_RULES", JSON.stringify(rules));
  revalidatePath("/settings");
}
