"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { putSetting, getSetting } from "@/lib/settings";
import { getBotFaqs } from "@/lib/botAi";
import { type BotKnowledgeStatus } from "@/lib/botKnowledge";
import { logAudit } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";
import { actingTenantId } from "@/lib/actingTenant";

const clean = (value: FormDataEntryValue | null, max = 5000) => String(value ?? "").trim().slice(0, max);

function dateBoundary(value: string, end = false): Date | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}+02:00`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

const revalidateKnowledge = () => {
  revalidatePath("/chatbot");
  revalidatePath("/chatbot/knowledge");
};

async function knowledgeSource(tenantId: string, sourceDocumentId: string | undefined) {
  if (!sourceDocumentId) return { sourceType: "manual" as const, sourceDocumentId: null, sourceLabel: null };
  const document = await prisma.libraryDocument.findFirst({
    where: { id: sourceDocumentId, tenantId },
    select: { name: true },
  });
  if (!document) return null;
  return { sourceType: "library" as const, sourceDocumentId, sourceLabel: document.name };
}

export async function saveBotSettings(formData: FormData) {
  return withActingStaffScope(async () => {
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
  });
}

export async function addFaq(formData: FormData) {
  return withActingStaffScope(async () => {
    await requireOwner();
    const question = clean(formData.get("question"), 500);
    const answer = clean(formData.get("answer"), 5000);
    const handoff = formData.get("handoff") === "on";
    if (!question || !answer) return;
    const faqs = await getBotFaqs();
    faqs.push({ id: crypto.randomUUID(), question, answer, handoff });
    await putSetting("BOT_FAQS", JSON.stringify(faqs));
    revalidatePath("/chatbot");
  });
}

export async function deleteFaq(id: string) {
  return withActingStaffScope(async () => {
    await requireOwner();
    const faqs = (await getBotFaqs()).filter((f) => f.id !== id);
    await putSetting("BOT_FAQS", JSON.stringify(faqs));
    revalidatePath("/chatbot");
  });
}

/**
 * Add a knowledge entry as DRAFT. Approval is deliberately a separate action so
 * pasting a new policy or excerpt cannot make it customer-facing in the same click.
 * A Library document may be attached for provenance; its bytes are not implicitly
 * trusted or indexed — the approved excerpt remains the actual model context.
 */
export async function addBotKnowledge(formData: FormData) {
  return withActingStaffScope(async () => {
    const owner = await requireOwner();
    const tenantId = await actingTenantId();
    const title = clean(formData.get("title"), 180);
    const content = clean(formData.get("content"), 5000);
    if (!title || !content) return;

    const sourceDocumentId = clean(formData.get("sourceDocumentId"), 120) || undefined;
    const source = await knowledgeSource(tenantId, sourceDocumentId);
    if (!source) return;
    const validFrom = dateBoundary(clean(formData.get("validFrom"), 20));
    const validUntil = dateBoundary(clean(formData.get("validUntil"), 20), true);
    if (validFrom && validUntil && validUntil < validFrom) return;

    await prisma.botKnowledgeEntry.create({ data: {
      tenantId,
      title,
      content,
      status: "draft",
      ...source,
      validFrom,
      validUntil,
    } });
    await logAudit({ action: "bot.knowledge_created", summary: `Added chatbot knowledge draft “${title}”`, user: owner });
    revalidateKnowledge();
  });
}

/** Editing an approved fact always returns it to Draft for a fresh review. */
export async function updateBotKnowledge(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const owner = await requireOwner();
    const tenantId = await actingTenantId();
    const title = clean(formData.get("title"), 180);
    const content = clean(formData.get("content"), 5000);
    if (!title || !content) return;
    const current = await prisma.botKnowledgeEntry.findFirst({ where: { id, tenantId } });
    if (!current) return;
    const sourceDocumentId = clean(formData.get("sourceDocumentId"), 120) || undefined;
    const source = await knowledgeSource(tenantId, sourceDocumentId);
    if (!source) return;
    const validFrom = dateBoundary(clean(formData.get("validFrom"), 20));
    const validUntil = dateBoundary(clean(formData.get("validUntil"), 20), true);
    if (validFrom && validUntil && validUntil < validFrom) return;
    await prisma.botKnowledgeEntry.updateMany({
      where: { id, tenantId },
      data: { title, content, ...source, validFrom: validFrom ?? null, validUntil: validUntil ?? null, status: "draft", approvedAt: null, approvedBy: null },
    });
    await logAudit({ action: "bot.knowledge_updated", summary: `Updated chatbot knowledge “${current.title}” and returned it to draft`, user: owner });
    revalidateKnowledge();
  });
}

export async function setBotKnowledgeStatus(id: string, status: BotKnowledgeStatus) {
  return withActingStaffScope(async () => {
    const owner = await requireOwner();
    if (!(["draft", "approved", "expired"] as BotKnowledgeStatus[]).includes(status)) return;
    const tenantId = await actingTenantId();
    const current = await prisma.botKnowledgeEntry.findFirst({ where: { id, tenantId } });
    if (!current) return;
    const now = new Date();
    await prisma.botKnowledgeEntry.updateMany({
      where: { id, tenantId },
      data: {
        status,
        ...(status === "approved" ? { approvedAt: now, approvedBy: owner.name } : {}),
        ...(status === "draft" ? { approvedAt: null, approvedBy: null } : {}),
      },
    });
    await logAudit({
      action: `bot.knowledge_${status}`,
      summary: `${status === "approved" ? "Approved" : status === "expired" ? "Expired" : "Returned to draft"} chatbot knowledge “${current.title}”`,
      user: owner,
    });
    revalidateKnowledge();
  });
}

export async function deleteBotKnowledge(id: string) {
  return withActingStaffScope(async () => {
    const owner = await requireOwner();
    const tenantId = await actingTenantId();
    const current = await prisma.botKnowledgeEntry.findFirst({ where: { id, tenantId } });
    if (!current) return;
    await prisma.botKnowledgeEntry.deleteMany({ where: { id, tenantId } });
    await logAudit({ action: "bot.knowledge_deleted", summary: `Deleted chatbot knowledge “${current.title}”`, user: owner });
    revalidateKnowledge();
  });
}

export async function whisperConfigured(): Promise<boolean> {
  return withActingStaffScope(async () => {
    await requireOwner();
    return Boolean(await getSetting("OPENAI_API_KEY"));
  });
}

export async function connectTelegram(formData: FormData): Promise<void> {
  return withActingStaffScope(async () => {
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
  });
}

export async function disconnectTelegram() {
  return withActingStaffScope(async () => {
    await requireOwner();
    const { deleteTelegramWebhook } = await import("@/lib/telegram");
    await deleteTelegramWebhook();
    await putSetting("BOT_TG_ENABLED", "false");
    await putSetting("TELEGRAM_BOT_TOKEN", "");
    await putSetting("TELEGRAM_WEBHOOK_SECRET", "");
    revalidatePath("/chatbot");
  });
}

export async function telegramStatus(): Promise<{ connected: boolean; enabled: boolean }> {
  return withActingStaffScope(async () => {
    await requireOwner();
    return { connected: Boolean(await getSetting("TELEGRAM_BOT_TOKEN")), enabled: (await getSetting("BOT_TG_ENABLED")) === "true" };
  });
}
