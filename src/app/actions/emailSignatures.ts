"use server";

import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
import { getActiveTenantId, isTenantOwner, requireTenantOwner, requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { asActionResult, refuse } from "@/lib/actionResult";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { listActingTenantTeams } from "@/lib/tenantActor";
import { parseSignatureDesign, SIGNATURE_DESIGN_KEY } from "@/lib/signature";
import { SIGNATURE_FIELDS, cleanDetail, mayEdit, parseTeamLines, type SignatureField } from "@/lib/signaturePeople";

/*
 * The Email signatures pack's people settings (Sean, 2026-11-20 — items 1–4 of email-signature-improvements.md):
 * a person's own details, the owner's rules (which details staff may change, a line per team, short replies), and the
 * owner setting any team member's details. Every write names the workspace; every rule is checked here, whatever the
 * form showed.
 */

const COLUMN: Record<Exclude<SignatureField, "photo">, "signatureQualifications" | "signatureDirectLine" | "signatureWhatsapp" | "signatureBookingUrl" | "signatureHours"> = {
  qualifications: "signatureQualifications",
  directLine: "signatureDirectLine",
  whatsapp: "signatureWhatsapp",
  bookingUrl: "signatureBookingUrl",
  hours: "signatureHours",
};

async function workspaceDesign(tenantId: string) {
  const row = await basePrisma.appSetting.findUnique({ where: { tenantId_key: { tenantId, key: SIGNATURE_DESIGN_KEY } }, select: { value: true } });
  return parseSignatureDesign(row?.value);
}

/**
 * The details this form may write: every field the form sent that this person may change (the owner: all of them),
 * each checked. A field the form didn't send — locked, not shown — is left exactly as it is.
 */
function detailsFrom(formData: FormData, locked: readonly SignatureField[], isOwner: boolean) {
  const data: Record<string, string | boolean | null> = {};
  for (const field of SIGNATURE_FIELDS) {
    if (!mayEdit(field, locked, isOwner)) continue;
    if (field === "photo") {
      if (formData.has("photoShown")) data.signaturePhoto = formData.get("photo") === "on";
      continue;
    }
    if (!formData.has(field)) continue;
    const cleaned = cleanDetail(field, String(formData.get(field) ?? ""));
    if (!cleaned.ok) refuse(cleaned.error);
    data[COLUMN[field]] = cleaned.value;
  }
  return data;
}

/** A person's own signature details — only those the owner hasn't locked. */
export async function saveMySignatureDetails(formData: FormData) {
  return asActionResult(async () => {
    const user = await requireUser();
    if (!(await isModuleEnabled("signatures"))) refuse("Email signatures is switched off for this workspace.");
    const tenantId = await getActiveTenantId();
    if (!tenantId) refuse("No workspace attached to this sign-in — sign out and back in.");
    const owner = await isTenantOwner();
    const design = await workspaceDesign(tenantId);
    const data = detailsFrom(formData, design.locked ?? [], owner);
    if (!Object.keys(data).length) return { success: "Nothing to change." };
    await basePrisma.user.update({ where: { id: user.id }, data });
    await logAudit({ action: "email_signature.details_saved", summary: "Updated their email signature details", user });
    revalidatePath("/email-signatures");
  });
}

/** The owner setting a team member's details — every field, locked or not (the locks are on staff, not the owner). */
export async function saveStaffSignatureDetails(userId: string, formData: FormData) {
  return asActionResult(async () => {
    const owner = await requireTenantOwner();
    if (!(await isModuleEnabled("signatures"))) refuse("Email signatures is switched off for this workspace.");
    const tenantId = await getActiveTenantId();
    if (!tenantId) refuse("No workspace attached to this sign-in — sign out and back in.");
    // The person must be in THIS workspace: the id came from the browser.
    const member = await basePrisma.tenantMember.findFirst({ where: { tenantId, userId }, select: { user: { select: { name: true } } } });
    if (!member) refuse("That person isn't in this workspace.");
    const data = detailsFrom(formData, [], true);
    if (!Object.keys(data).length) return { success: "Nothing to change." };
    await basePrisma.user.update({ where: { id: userId }, data });
    await logAudit({ action: "email_signature.details_saved", summary: `Updated ${member.user.name}'s email signature details`, user: owner });
    revalidatePath("/email-signatures");
  });
}

/** The owner's rules: which details staff may change, a line per team, and whether replies get the short signature. */
export async function saveSignatureRules(formData: FormData) {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    if (!(await isModuleEnabled("signatures"))) refuse("Email signatures is switched off for this workspace.");
    const tenantId = await getActiveTenantId();
    if (!tenantId) refuse("No workspace attached to this sign-in — sign out and back in.");
    // Only this workspace's teams can have a line, whatever the form sent.
    const teams = await listActingTenantTeams();
    const teamLines = parseTeamLines(teams.map((team) => ({ teamId: team.id, line: String(formData.get(`team_${team.id}`) ?? "") })));
    const current = await workspaceDesign(tenantId);
    const next = parseSignatureDesign(JSON.stringify({
      ...current,
      locked: SIGNATURE_FIELDS.filter((field) => formData.get(`lock_${field}`) === "on"),
      teams: teamLines,
      shortReplies: formData.get("shortReplies") === "on",
    }));
    const value = JSON.stringify(next);
    await basePrisma.appSetting.upsert({
      where: { tenantId_key: { tenantId, key: SIGNATURE_DESIGN_KEY } },
      update: { value },
      create: { tenantId, key: SIGNATURE_DESIGN_KEY, value },
    });
    await logAudit({
      action: "email_signature.rules_saved",
      summary: `Email signature rules: ${next.locked?.length ? `${next.locked.length} detail(s) locked` : "staff may change all their details"}, ${next.teams?.length ?? 0} team line(s), short replies ${next.shortReplies ? "on" : "off"}`,
      user,
    });
    revalidatePath("/email-signatures");
  });
}
