"use server";

import { revalidatePath } from "next/cache";
import { requireTenantOwner } from "@/lib/auth";
import { getSetting, putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, refuse } from "@/lib/actionResult";
import {
  ASSISTANT_PROFILE_KEY,
  WORKSPACE_INSTRUCTIONS_CHARS,
  assistantProfile,
  cleanOwnerText,
  normaliseSoul,
  parseProfile,
} from "@/lib/assistantSoul";

/**
 * The workspace's assistant: its name, tone, workspace instructions and soul.
 * Workspace owner only. The personality card and the Advanced → Soul card are
 * separate forms, so only the fields a form sends are changed; the rest are kept.
 */
export async function saveAssistantProfile(formData: FormData) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireTenantOwner();
      const current = parseProfile(await getSetting(ASSISTANT_PROFILE_KEY));
      const field = (key: string) => (formData.has(key) ? String(formData.get(key) ?? "") : null);
      const parsed = assistantProfile.safeParse({
        name: field("name") === null ? current.name : field("name")!.trim() || "Assistant",
        tone: field("tone") ?? current.tone,
        rules: field("rules") === null ? current.rules : cleanOwnerText(field("rules")!, WORKSPACE_INSTRUCTIONS_CHARS),
        soul: field("soul") === null ? current.soul : normaliseSoul(field("soul")!),
        // An unticked box sends nothing, so the form says it showed the box.
        webSearch: formData.has("webSearchShown") ? formData.get("webSearch") === "on" : current.webSearch,
      });
      if (!parsed.success) refuse(`Check the name (up to 40 characters), tone, workspace instructions (up to ${WORKSPACE_INSTRUCTIONS_CHARS}) and soul (up to 3000).`);
      await putSetting(ASSISTANT_PROFILE_KEY, JSON.stringify(parsed.data));
      await logAudit({
        action: "assistant.profile_updated",
        summary: `Updated the assistant's personality (“${parsed.data.name}”)${parsed.data.webSearch !== current.webSearch ? ` — internet search ${parsed.data.webSearch ? "on" : "off"}` : ""}`,
        user,
      });
      revalidatePath("/settings/assistant");
      revalidatePath("/assistant");
      return { success: "Saved" };
    }),
  );
}
