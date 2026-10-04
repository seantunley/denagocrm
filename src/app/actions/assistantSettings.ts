"use server";

import { revalidatePath } from "next/cache";
import { requireTenantOwner } from "@/lib/auth";
import { putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, refuse } from "@/lib/actionResult";
import { ASSISTANT_PROFILE_KEY, assistantProfile } from "@/lib/assistantSoul";

/** The workspace's assistant: its name, tone and house rules. Workspace owner only. */
export async function saveAssistantProfile(formData: FormData) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireTenantOwner();
      const parsed = assistantProfile.safeParse({
        name: String(formData.get("name") ?? "").trim() || "Assistant",
        tone: String(formData.get("tone") ?? "warm"),
        rules: String(formData.get("rules") ?? ""),
      });
      if (!parsed.success) refuse("Check the name (up to 40 characters), tone and house rules (up to 1500).");
      await putSetting(ASSISTANT_PROFILE_KEY, JSON.stringify(parsed.data));
      await logAudit({ action: "assistant.profile_updated", summary: `Updated the assistant's personality (“${parsed.data.name}”)`, user });
      revalidatePath("/settings/assistant");
      revalidatePath("/assistant");
      return { success: "Saved" };
    }),
  );
}
