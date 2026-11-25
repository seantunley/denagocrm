"use server";

import { allocateUnit } from "@/app/actions/stock";

/**
 * "Allocate" from the deal page (W2-05): the unit is picked here, the deal is
 * fixed. Everything else is the stock page's own allocateUnit — its permission,
 * this quote's access, the unit's status and the accepted-quote rule — so the
 * deal page can't allocate anything the stock page wouldn't.
 */
export async function allocateUnitToDeal(quoteId: string, formData: FormData) {
  const unitId = String(formData.get("unitId") ?? "").trim();
  if (!unitId) return { error: "Choose a unit." };
  const form = new FormData();
  form.set("quoteId", quoteId);
  return allocateUnit(unitId, form);
}
