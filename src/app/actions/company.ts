"use server";

import { revalidatePath } from "next/cache";
import { requireTenantOwner } from "@/lib/auth";
import { putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { COMPANY_KEYS, type CompanyProfile } from "@/lib/companyProfile";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, type ActionResult } from "@/lib/actionResult";
import { parseRecordLabels, RECORD_KINDS, RECORD_LABELS_KEY } from "@/lib/recordLabels";

/**
 * What this workspace calls leads, deals and job cards (Settings → Company profile → Names for records). Saved
 * tidied: a blank box goes back to the built-in word, so what is stored is what the screens show.
 */
export async function saveRecordLabels(formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const submitted = Object.fromEntries(
      RECORD_KINDS.map((kind) => [kind, { one: String(formData.get(`${kind}_one`) ?? ""), many: String(formData.get(`${kind}_many`) ?? "") }]),
    );
    const labels = parseRecordLabels(JSON.stringify(submitted));
    await putSetting(RECORD_LABELS_KEY, JSON.stringify(labels));
    await logAudit({
      action: "company.record_labels_updated",
      summary: `Names for records: ${RECORD_KINDS.map((kind) => `${labels[kind].one} / ${labels[kind].many}`).join(", ")}`,
      user,
    });
    // Every page shows them (the menu is in the shell).
    revalidatePath("/", "layout");
    return { success: "Names saved" };
  });
}

export async function saveCompanyProfile(formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requireTenantOwner();
    const fields = Object.keys(COMPANY_KEYS) as (keyof CompanyProfile)[];
    for (const field of fields) {
      await putSetting(COMPANY_KEYS[field], String(formData.get(field) ?? "").trim());
    }
    await logAudit({ action: "company.profile_updated", summary: "Updated company profile", user });
    revalidatePath("/settings/company");
  });
}
