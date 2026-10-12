"use server";

import { revalidatePath } from "next/cache";
import { requireTenantOwner } from "@/lib/auth";
import { getSetting, putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { withActingStaffScope, actingOwnerTenantId } from "@/lib/actingScope";
import { basePrisma } from "@/lib/db";
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
import { ASSISTANT_WHATSAPP_CONFIRM_KEY, ASSISTANT_WHATSAPP_HANDOFF_KEY, ASSISTANT_WHATSAPP_HANDOFF_TO_KEY, ASSISTANT_WHATSAPP_TEMPLATE_KEY, formatUpdateTemplate, handoffRecipient, parseUpdateTemplate, whatsappConfirmOn, whatsappHandoffOn } from "@/lib/assistantWhatsAppRules";

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
      // Confirming tasks from a phone. Default OFF: it lets a linked phone CHANGE
      // records, where until now it could only read answers. Audited both ways.
      const confirm = formData.get("whatsappConfirm") === "on";
      if (confirm !== whatsappConfirmOn(await getSetting(ASSISTANT_WHATSAPP_CONFIRM_KEY))) {
        await putSetting(ASSISTANT_WHATSAPP_CONFIRM_KEY, confirm ? "on" : "off");
        await logAudit({
          action: confirm ? "assistant.whatsapp_confirm_enabled" : "assistant.whatsapp_confirm_disabled",
          summary: confirm
            ? "Let staff confirm the assistant's proposed tasks from their linked WhatsApp"
            : "Turned off confirming the assistant's tasks on WhatsApp",
          user,
        });
        revalidatePath("/settings/assistant");
      }
      // Telling staff on their linked WhatsApp when the chatbot hands a conversation
      // to a person. Default OFF; it only ever messages staff. Audited both ways.
      const handoff = formData.get("whatsappHandoff") === "on";
      if (handoff !== whatsappHandoffOn(await getSetting(ASSISTANT_WHATSAPP_HANDOFF_KEY))) {
        await putSetting(ASSISTANT_WHATSAPP_HANDOFF_KEY, handoff ? "on" : "off");
        await logAudit({
          action: handoff ? "assistant.whatsapp_handoff_enabled" : "assistant.whatsapp_handoff_disabled",
          summary: handoff
            ? "Chatbot handoffs now go to a person's linked WhatsApp, with the customer's details and the chat so far"
            : "Turned off sending chatbot handoffs to a person's WhatsApp",
          user,
        });
        revalidatePath("/settings/assistant");
      }
      // WHO it goes to. A member of THIS workspace with a verified linked phone, or
      // everyone — never an id the form made up: it is checked against the links.
      const wanted = handoffRecipient(String(formData.get("whatsappHandoffTo") ?? ""));
      const tenantId = await actingOwnerTenantId();
      const linked = wanted
        ? await basePrisma.assistantPhoneLink.findFirst({ where: { tenantId, userId: wanted, verifiedAt: { not: null }, waId: { not: null } }, select: { userId: true } })
        : null;
      if (wanted && !linked) return refuse("That person has no linked WhatsApp — they link it themselves on the Ask page, then you can choose them here.");
      const to = wanted ?? "all";
      if (to !== ((await getSetting(ASSISTANT_WHATSAPP_HANDOFF_TO_KEY)) || "all")) {
        await putSetting(ASSISTANT_WHATSAPP_HANDOFF_TO_KEY, to);
        await logAudit({
          action: "assistant.whatsapp_handoff_recipient",
          summary: wanted ? "Chatbot handoffs on WhatsApp now go to one chosen team member" : "Chatbot handoffs on WhatsApp now go to everyone with a linked phone who may open the inbox",
          user,
          entityType: wanted ? "User" : undefined,
          entityId: wanted ?? undefined,
        });
        revalidatePath("/settings/assistant");
      }
      // The approved template that says "you have an update" when WhatsApp will
      // take nothing else (nothing from that phone in 24 hours). Blank = none.
      const templateName = String(formData.get("updateTemplate") ?? "").trim();
      const template = templateName ? parseUpdateTemplate(formatUpdateTemplate(templateName, String(formData.get("updateTemplateLanguage") ?? ""))) : null;
      if (templateName && !template) {
        return refuse("The template name must be exactly as it is in WhatsApp Manager: lower-case letters, numbers and underscores only.");
      }
      const stored = template ? formatUpdateTemplate(template.name, template.language) : "";
      if (stored !== ((await getSetting(ASSISTANT_WHATSAPP_TEMPLATE_KEY)) ?? "")) {
        await putSetting(ASSISTANT_WHATSAPP_TEMPLATE_KEY, stored);
        await logAudit({
          action: template ? "assistant.whatsapp_template_set" : "assistant.whatsapp_template_cleared",
          summary: template
            ? `Set the WhatsApp template the assistant uses to say an update is waiting: ${template.name} (${template.language})`
            : "Removed the WhatsApp template the assistant uses to say an update is waiting",
          user,
        });
        revalidatePath("/settings/assistant");
      }
      return { success: `${whatsapp.success ?? "Saved"}${on ? " · voice replies on" : ""}${confirm ? " · confirming on WhatsApp on" : ""}` };
    }),
  );
}
