"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
import { requireTenantOwner, requireUser } from "@/lib/auth";
import { requireAnyPermission } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { withActingStaffScope, actingOwnerTenantId } from "@/lib/actingScope";
import { asActionResult } from "@/lib/actionResult";
import { isWhatsAppConfigured } from "@/lib/whatsapp";
import { ASSISTANT_PERMISSIONS } from "@/lib/assistantUser";
import { assistantWhatsAppOn, businessWhatsAppNumber, hashLinkCode } from "@/lib/assistantWhatsApp";
import { rateLimitKey, registerRateLimitAttempt } from "@/lib/rateLimit";
import {
  ASSISTANT_WHATSAPP_KEY,
  LINK_CODE_POLICY,
  LINK_CODE_TTL_MS,
  formatLinkCode,
  linkCodeText,
  waMeLink,
} from "@/lib/assistantWhatsAppRules";

/*
 * DAX on WhatsApp — the controls. The owner turns it on for the workspace; each
 * person links (and unlinks) THEIR OWN number. There is no way here to name a
 * number at all: a link is only ever completed by the code arriving from the
 * phone (lib/assistantWhatsApp.ts), so nobody can type in someone else's.
 */

function revalidate() {
  revalidatePath("/assistant");
  revalidatePath("/settings/assistant");
}

/** The workspace switch. Owner only; audited both ways. */
export async function saveAssistantWhatsApp(formData: FormData) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireTenantOwner();
      const on = formData.get("enabled") === "on";
      await putSetting(ASSISTANT_WHATSAPP_KEY, on ? "on" : "off");
      await logAudit({
        action: on ? "assistant.whatsapp_enabled" : "assistant.whatsapp_disabled",
        summary: on ? "Let staff link their own WhatsApp to ask the assistant" : "Turned off asking the assistant on WhatsApp",
        user,
      });
      revalidate();
      return { success: on ? "On — staff can link their WhatsApp" : "Off" };
    }),
  );
}

export type WhatsAppLinkStart =
  | { ok: true; text: string; waLink: string; number: string | null; minutes: number }
  | { ok: false; error: string };

/**
 * A fresh code for the caller's OWN link. Same gate as asking on the page
 * (assistant permission, Automation & AI on) plus the workspace switch and a
 * configured WhatsApp. Only the code's hash is stored; the code itself goes back
 * to this person once, for them to send. Asking again replaces the code AND
 * unlinks any number linked before — linking is always starting over.
 */
export async function startWhatsAppLink(): Promise<WhatsAppLinkStart> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    if (!(await isModuleEnabled("automation"))) {
      return { ok: false, error: "Ask the CRM is part of the Automation & AI module, which is off for this workspace." };
    }
    if (!(await assistantWhatsAppOn())) return { ok: false, error: "Asking on WhatsApp is off for this workspace." };
    if (!(await isWhatsAppConfigured())) return { ok: false, error: "WhatsApp isn't connected for this workspace yet." };
    const tenantId = await actingOwnerTenantId();
    const quota = await registerRateLimitAttempt(rateLimitKey("assistant-wa-code", `${tenantId}:${user.id}`), LINK_CODE_POLICY);
    if (!quota.allowed) return { ok: false, error: "That's a lot of codes — wait a few minutes and try again." };

    const code = formatLinkCode(crypto.randomInt(0, 1_000_000));
    const codeHash = hashLinkCode(tenantId, user.id, code);
    const codeExpiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
    // The caller's own row, by (workspace, caller) — there is no id or number to pass in.
    const link = await basePrisma.assistantPhoneLink.upsert({
      where: { tenantId_userId: { tenantId, userId: user.id } },
      create: { tenantId, userId: user.id, codeHash, codeExpiresAt },
      update: { codeHash, codeExpiresAt, waId: null, verifiedAt: null },
      select: { id: true },
    });
    await logAudit({
      action: "assistant.whatsapp_code_issued",
      summary: "Asked for a code to link their WhatsApp to the assistant",
      user,
      entityType: "AssistantPhoneLink",
      entityId: link.id,
    });
    const number = await businessWhatsAppNumber(tenantId);
    revalidate();
    return {
      ok: true,
      text: linkCodeText(code),
      waLink: waMeLink(number?.digits, code),
      number: number?.display ?? null,
      minutes: LINK_CODE_TTL_MS / 60_000,
    };
  });
}

/**
 * Remove the caller's OWN link — always allowed while signed in to the
 * workspace, switch or no switch: taking your number back is never gated.
 */
export async function unlinkMyWhatsApp() {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireUser();
      const tenantId = await actingOwnerTenantId();
      const removed = await basePrisma.assistantPhoneLink.deleteMany({ where: { tenantId, userId: user.id } });
      if (removed.count) {
        await logAudit({ action: "assistant.whatsapp_unlinked", summary: "Unlinked their WhatsApp from the assistant", user, entityType: "AssistantPhoneLink" });
      }
      revalidate();
      return { success: "Unlinked" };
    }),
  );
}
