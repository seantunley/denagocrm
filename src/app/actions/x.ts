"use server";

import { requirePermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { currentTenantScope } from "@/lib/tenantScope";
import { resolveTenantCredential } from "@/lib/settings";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";

export async function draftXReplyWithGrok(conversationId: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  await requirePermission("inbox.reply");
  const tenantId = currentTenantScope()?.tenantId ?? DEFAULT_TENANT_ID;
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, channel: "x", tenantId },
    include: { messages: { orderBy: { occurredAt: "desc" }, take: 12, select: { direction: true, body: true } } },
  });
  if (!conversation) return { ok: false, error: "X conversation not found in this workspace." };
  const [apiKey, configuredModel, enabled] = await Promise.all([
    resolveTenantCredential(tenantId, "XAI_API_KEY"),
    resolveTenantCredential(tenantId, "XAI_MODEL"),
    resolveTenantCredential(tenantId, "XAI_DRAFTS_ENABLED"),
  ]);
  if (enabled !== "true") return { ok: false, error: "Enable Grok reply drafts in Settings → Integrations first." };
  if (!apiKey) return { ok: false, error: "Add a Grok API key in Settings → Integrations." };
  const redact = (value: string) => value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[phone redacted]")
    .slice(0, 1_000);
  const history = conversation.messages.slice(0, 6).reverse().map((message) => ({
    role: message.direction === "outbound" ? "assistant" : "user",
    content: redact(message.body),
  }));
  try {
    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: configuredModel || "grok-4.6",
        temperature: 0.4,
        messages: [
          { role: "system", content: "Draft a concise, helpful CRM reply for X. Never invent facts, prices, availability, or commitments. Return only the reply text." },
          ...history,
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => null);
    const text = String(body?.choices?.[0]?.message?.content ?? "").trim();
    if (!response.ok || !text) return { ok: false, error: response.status === 401 ? "The Grok API key must be updated." : "Grok could not create a draft." };
    return { ok: true, text };
  } catch {
    return { ok: false, error: "Grok could not be reached." };
  }
}
