"use server";

import { revalidatePath } from "next/cache";
import { requireTenantOwner } from "@/lib/auth";
import { getSetting, putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, refuse } from "@/lib/actionResult";
import { ASSISTANT_PROFILE_KEY, assistantProfile, normaliseSoul, parseProfile } from "@/lib/assistantSoul";

/**
 * The workspace's assistant: its name, tone, house rules and soul. Workspace
 * owner only. The personality card and the Advanced → Soul card are separate
 * forms, so only the fields a form sends are changed; the rest are kept.
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
        rules: field("rules") ?? current.rules,
        soul: field("soul") === null ? current.soul : normaliseSoul(field("soul")!),
      });
      if (!parsed.success) refuse("Check the name (up to 40 characters), tone, house rules (up to 1500) and soul (up to 3000).");
      await putSetting(ASSISTANT_PROFILE_KEY, JSON.stringify(parsed.data));
      await logAudit({ action: "assistant.profile_updated", summary: `Updated the assistant's personality (“${parsed.data.name}”)`, user });
      revalidatePath("/settings/assistant");
      revalidatePath("/assistant");
      return { success: "Saved" };
    }),
  );
}
