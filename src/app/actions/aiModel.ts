"use server";

import { revalidatePath } from "next/cache";
import { requireTenantOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { asActionResult, refuse } from "@/lib/actionResult";
import { getSetting } from "@/lib/settings";
import { codexModel } from "@/lib/codex";
import { modelChoices } from "@/lib/codexProtocol";
import { AI_CLAUDE_MODEL_KEY, CLAUDE_MODEL_CHOICES, parseAiModelChoice } from "@/lib/aiProviderRules";
import { saveAiChoice } from "@/lib/aiModelSave";
import { aiModelCatalog } from "@/lib/aiModelCatalog";

/**
 * Settings → Integrations → "Which AI the CRM uses": one model picker, so one save sets the provider AND its model.
 * A ChatGPT model is the same setting DAX uses (CODEX_MODEL) — there is one ChatGPT model per workspace, not two.
 * Owner only; the value comes from the browser, so only a model on offer is saved.
 */
export async function saveAiModel(formData: FormData) {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    // What the page offered (the providers' own lists), plus the built-in lists: a model the page showed is accepted
    // even if a provider can't be asked again this second.
    const current = { chatgpt: await codexModel(), claude: (await getSetting(AI_CLAUDE_MODEL_KEY)) ?? "" };
    const catalog = await aiModelCatalog(current);
    const ids = (list: { id: string }[]) => list.map((item) => item.id);
    const choice = parseAiModelChoice(
      String(formData.get("value") ?? ""),
      [...ids(catalog.chatgpt), ...ids(modelChoices(current.chatgpt))],
      [...ids(catalog.claude), ...ids(CLAUDE_MODEL_CHOICES)],
    );
    if (!choice) refuse("That model isn't on the list any more — reload the page and choose again.");
    await saveAiChoice(choice); // provider and model together, or neither (lib/aiModelSave)
    await logAudit({
      action: "integration.ai_model_changed",
      summary: `AI set to ${choice.provider === "chatgpt" ? "ChatGPT" : "Claude"} · ${choice.model || "automatic"}`,
      user,
    });
    revalidatePath("/settings", "layout");
  });
}
