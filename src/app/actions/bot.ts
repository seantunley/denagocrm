"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { putSetting, getSetting } from "@/lib/settings";
import { getBotFaqs } from "@/lib/botAi";
import { getBotKnowledgeEntries, type BotKnowledgeEntry, type BotKnowledgeStatus } from "@/lib/botKnowledge";
import { builderOwnedWhere } from "@/lib/flowTenantScopeServer";
import { logAudit } from "@/lib/audit";

const clean = (value: FormDataEntryValue | null, max = 5000) => String(value ?? "").trim().slice(0, max);

function dateBoundary(value: string, end = false): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}+02:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export async function saveBotSettings(formData: FormData) {
  const owner = await requireOwner();
  const enabled = formData.get("enabled") === "on";
  const aiEnabled = formData.get("aiEnabled") === "on";
  const flowEnabled = formData.get("flowEnabled") === "on";
  const dmEnabled = formData.get("dmEnabled") === "on";
  await putSetting("BOT_ENABLED", enabled ? "true" : "false");
  await putSetting("BOT_AI_ENABLED", aiEnabled ? "true" : "false");
  await putSetting("BOT_FLOW_ENABLED", flowEnabled ? "true" : "false");
  await putSetting("BOT_DM_ENABLED", dmEnabled ? "true" : "false");
  await putSetting("BOT_AI_BRIEF", clean(formData.get("brief")));
  await putSetting("BOT_HOURS", `${clean(formData.get("start"), 10) || "08:00"}-${clean(formData.get("end"), 10) || "17:00"}`);
  await putSetting("BOT_DAYS", formData.getAll("days").map(String).join(",") || "1,2,3,4,5");
  await putSetting("BOT_AFTERHOURS_MSG", clean(formData.get("afterhours")));
  const whisper = clean(formData.get("whisperKey"), 500);
  if (whisper && !whisper.startsWith("•")) await putSetting("OPENAI_API_KEY", whisper);
  await logAudit({ action: "bot.settings", summary: `WhatsApp bot ${enabled ? "enabled" : "disabled"}${aiEnabled ? " (AI assistant on)" : ""}`, user: owner });
  revalidatePath("/chatbot");
}

export async function addFaq(formData: FormData) {
  await requireOwner();
  const question = clean(formData.get("question"), 500);
  const answer = clean(formData.get("answer"), 5000);
  const handoff = formData.get("handoff") === "on";
  if (!question || !answer) return;
  const faqs = await getBotFaqs();
  faqs.push({ id: crypto.randomUUID(), question, answer, handoff });
  await putSetting("BOT_FAQS", JSON.stringify(faqs));
  revalidatePath("/chatbot");
}

export async function deleteFaq(id: string) {
  await requireOwner();
  const faqs = (await getBotFaqs()).filter((f) => f.id !== id);
  await putSetting("BOT_FAQS", JSON.stringify(faqs));
  revalidatePath("/chatbot");
}

/**
 * Add a knowledge entry as DRAFT. Approval is deliberately a separate action so
 * pasting a new policy or excerpt cannot make it customer-facing in the same click.
 * A Library document may be attached for provenance; its bytes are not implicitly
 * trusted or indexed — the approved excerpt remains the actual model context.
 */
export async function addBotKnowledge(formData: FormData) {
  const owner = await requireOwner();
  const title = clean(formData.get("title"), 180);
  const content = clean(formData.get("content"), 5000);
  if (!title || !content) return;

  const sourceDocumentId = clean(formData.get("sourceDocumentId"), 120) || undefined;
  let sourceLabel: string | undefined;
  if (sourceDocumentId) {
    // Provenance must come from a document this workspace owns; the id is posted
    // by the form. The entry stores the document's NAME, so an unowned lookup
    // would copy another workspace's filename into this one's knowledge base.
    const document = await prisma.libraryDocument.findFirst({
      where: { id: sourceDocumentId, ...builderOwnedWhere() },
      select: { name: true },
    });
    if (!document) return;
    sourceLabel = document.name;
  }

  const now = new Date().toISOString();
  const entry: BotKnowledgeEntry = {
    id: crypto.randomUUID(),
    title,
    content,
    status: "draft",
    sourceType: sourceDocumentId ? "library" : "manual",
    sourceDocumentId,
    sourceLabel,
    validFrom: dateBoundary(clean(formData.get("validFrom"), 20)),
    validUntil: dateBoundary(clean(formData.get("validUntil"), 20), true),
    createdAt: now,
    updatedAt: now,
  };
  const entries = await getBotKnowledgeEntries();
  entries.unshift(entry);
  await putSetting("BOT_KNOWLEDGE_ENTRIES", JSON.stringify(entries.slice(0, 250)));
  await logAudit({ action: "bot.knowledge_created", summary: `Added chatbot knowledge draft “${title}”`, user: owner });
  revalidatePath("/chatbot");
}

export async function setBotKnowledgeStatus(id: string, status: BotKnowledgeStatus) {
  const owner = await requireOwner();
  if (!(["draft", "approved", "expired"] as BotKnowledgeStatus[]).includes(status)) return;
  const entries = await getBotKnowledgeEntries();
  const current = entries.find((entry) => entry.id === id);
  if (!current) return;
  const now = new Date().toISOString();
  const next = entries.map((entry) => entry.id === id ? {
    ...entry,
    status,
    updatedAt: now,
    ...(status === "approved" ? { approvedAt: now, approvedBy: owner.name } : {}),
  } : entry);
  await putSetting("BOT_KNOWLEDGE_ENTRIES", JSON.stringify(next));
  await logAudit({
    action: `bot.knowledge_${status}`,
    summary: `${status === "approved" ? "Approved" : status === "expired" ? "Expired" : "Returned to draft"} chatbot knowledge “${current.title}”`,
    user: owner,
  });
  revalidatePath("/chatbot");
}

export async function deleteBotKnowledge(id: string) {
  const owner = await requireOwner();
  const entries = await getBotKnowledgeEntries();
  const current = entries.find((entry) => entry.id === id);
  if (!current) return;
  await putSetting("BOT_KNOWLEDGE_ENTRIES", JSON.stringify(entries.filter((entry) => entry.id !== id)));
  await logAudit({ action: "bot.knowledge_deleted", summary: `Deleted chatbot knowledge “${current.title}”`, user: owner });
  revalidatePath("/chatbot");
}

export async function whisperConfigured(): Promise<boolean> {
  await requireOwner();
  return Boolean(await getSetting("OPENAI_API_KEY"));
}

export async function connectTelegram(formData: FormData): Promise<void> {
  await requireOwner();
  const token = clean(formData.get("token"), 500);
  if (!token) return;
  await putSetting("TELEGRAM_BOT_TOKEN", token);
  const secret = crypto.randomBytes(16).toString("hex");
  await putSetting("TELEGRAM_WEBHOOK_SECRET", secret);
  const { setTelegramWebhook } = await import("@/lib/telegram");
  const { appBaseUrl } = await import("@/lib/campaigns");
  const res = await setTelegramWebhook(`${appBaseUrl()}/api/webhooks/telegram`, secret);
  await putSetting("BOT_TG_ENABLED", res.ok ? "true" : "false");
  revalidatePath("/chatbot");
}

export async function disconnectTelegram() {
  await requireOwner();
  const { deleteTelegramWebhook } = await import("@/lib/telegram");
  await deleteTelegramWebhook();
  await putSetting("BOT_TG_ENABLED", "false");
  await putSetting("TELEGRAM_BOT_TOKEN", "");
  await putSetting("TELEGRAM_WEBHOOK_SECRET", "");
  revalidatePath("/chatbot");
}

export async function telegramStatus(): Promise<{ connected: boolean; enabled: boolean }> {
  await requireOwner();
  return { connected: Boolean(await getSetting("TELEGRAM_BOT_TOKEN")), enabled: (await getSetting("BOT_TG_ENABLED")) === "true" };
}
