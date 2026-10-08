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
import { ASSISTANT_VOICE_REPLIES_KEY, voiceRepliesSwitchOn } from "@/lib/assistantVoiceRules";
import { saveAssistantWhatsApp } from "@/app/actions/assistantWhatsApp";

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

/**
 * The "on WhatsApp" card's Save: the WhatsApp switch (saved by its own action,
 * unchanged) and, in the same form, voice replies. Voice replies default OFF —
 * every spoken answer costs ElevenLabs credit — and are audited only when they
 * actually change, so re-saving the card doesn't fill the trail.
 */
export async function saveAssistantWhatsAppCard(formData: FormData) {
  const whatsapp = await saveAssistantWhatsApp(formData);
  if (whatsapp.error) return whatsapp;
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireTenantOwner();
      const on = formData.get("voiceReplies") === "on";
      if (on !== voiceRepliesSwitchOn(await getSetting(ASSISTANT_VOICE_REPLIES_KEY))) {
        await putSetting(ASSISTANT_VOICE_REPLIES_KEY, on ? "on" : "off");
        await logAudit({
          action: on ? "assistant.voice_replies_enabled" : "assistant.voice_replies_disabled",
          summary: on ? "Let the assistant reply with voice notes and read answers aloud (uses ElevenLabs credit)" : "Turned off the assistant's voice replies",
          user,
        });
        revalidatePath("/settings/assistant");
      }
      return { success: `${whatsapp.success ?? "Saved"}${on ? " · voice replies on" : ""}` };
    }),
  );
}
