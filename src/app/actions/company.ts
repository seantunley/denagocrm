"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { COMPANY_KEYS, type CompanyProfile } from "@/lib/companyProfile";
import { withActingStaffScope } from "@/lib/actingScope";

export async function saveCompanyProfile(formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requireOwner();
    const fields = Object.keys(COMPANY_KEYS) as (keyof CompanyProfile)[];
    for (const field of fields) {
      await putSetting(COMPANY_KEYS[field], String(formData.get(field) ?? "").trim());
    }
    await logAudit({ action: "company.profile_updated", summary: "Updated company profile", user });
    revalidatePath("/settings/company");
  });
}
