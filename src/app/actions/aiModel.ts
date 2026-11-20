"use server";

import { revalidatePath } from "next/cache";
import { requireTenantOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { asActionResult, refuse } from "@/lib/actionResult";
import { putSetting } from "@/lib/settings";
import { CODEX_MODEL_KEY, codexModel } from "@/lib/codex";
import { modelChoices } from "@/lib/codexProtocol";
import { AI_CLAUDE_MODEL_KEY, AI_PROVIDER_KEY, parseAiModelChoice } from "@/lib/aiProviderRules";

/**
 * Settings → Integrations → "Which AI the CRM uses": one model picker, so one save sets the provider AND its model.
 * A ChatGPT model is the same setting DAX uses (CODEX_MODEL) — there is one ChatGPT model per workspace, not two.
 * Owner only; the value comes from the browser, so only a model on offer is saved.
 */
export async function saveAiModel(formData: FormData) {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const offered = modelChoices(await codexModel()).map((choice) => choice.id);
    const choice = parseAiModelChoice(String(formData.get("value") ?? ""), offered);
    if (!choice) refuse("That model isn't on the list any more — reload the page and choose again.");
    await putSetting(AI_PROVIDER_KEY, choice.provider);
    await putSetting(choice.provider === "chatgpt" ? CODEX_MODEL_KEY : AI_CLAUDE_MODEL_KEY, choice.model);
    await logAudit({
      action: "integration.ai_model_changed",
      summary: `AI set to ${choice.provider === "chatgpt" ? "ChatGPT" : "Claude"} · ${choice.model || "automatic"}`,
      user,
    });
    revalidatePath("/settings", "layout");
  });
}
