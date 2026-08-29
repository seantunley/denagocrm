"use server";

import { requireOwner } from "@/lib/auth";
import { generateBotReply } from "@/lib/botAi";
import { getBotKnowledgeEntries, retrieveRelevantKnowledge } from "@/lib/botKnowledge";
import { withActingStaffScope } from "@/lib/actingScope";

export type BotPreviewState = {
  error?: string;
  question?: string;
  reply?: string;
  confidence?: "high" | "medium" | "low";
  intent?: string;
  handoff?: boolean;
  handoffReason?: string;
  handoffSummary?: string;
  knowledge?: { id: string; title: string; sourceLabel?: string }[];
};

/**
 * Owner-only dry run of the exact production decision function. It performs no
 * sends, no CRM actions and no session writes; the only provider call is the
 * same AI inference production would make for an open question.
 */
export async function previewBotAnswer(
  _previous: BotPreviewState | undefined,
  formData: FormData,
): Promise<BotPreviewState> {
  return withActingStaffScope(async () => {
    await requireOwner();
    const question = String(formData.get("question") ?? "").trim().slice(0, 3000);
    const customerName = String(formData.get("customerName") ?? "").trim().slice(0, 120) || null;
    const isCustomer = formData.get("isCustomer") === "on";
    if (!question) return { error: "Enter a customer question to test." };

    const [decision, entries] = await Promise.all([
      generateBotReply({
        history: [{ role: "user", content: question }],
        customerName,
        isCustomer,
      }),
      getBotKnowledgeEntries(),
    ]);
    if (!decision) {
      return {
        error: "The assistant could not produce a decision. Check the AI provider configuration and System Log.",
        question,
      };
    }

    const knowledge = retrieveRelevantKnowledge(entries, question).map((entry) => ({
      id: entry.id,
      title: entry.title,
      sourceLabel: entry.sourceLabel,
    }));
    return {
      question,
      reply: decision.reply,
      confidence: decision.confidence,
      intent: decision.intent,
      handoff: decision.handoff,
      handoffReason: decision.handoffReason,
      handoffSummary: decision.handoffSummary,
      knowledge,
    };
  });
}
