"use server";

import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { requireQuoteAccess } from "@/lib/permissions";
import { actingTenantId } from "@/lib/actingTenant";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { parseMoneyInput } from "@/lib/moneyInput";
import { getRegionalSettings } from "@/lib/settings";
import { logAudit } from "@/lib/audit";

/**
 * Supplier quote → the customer quote's costs: a cost per unit, excl. VAT and in the quote's own currency,
 * for each line that has one on the supplier's paper. Feeds the internal margin (lib/pricing.ts). Cost is
 * never on the customer's document or in a signing record, so a sent or accepted quote can take it — a
 * superseded or deleted one cannot. Fields `cost_<itemId>`; a blank box leaves that line as it was.
 */
export async function saveQuoteLineCosts(quoteId: string, revalidate: string, formData: FormData): Promise<ActionResult> {
  return withActingStaffScope(async () =>
    asActionResult(async () => {
      const user = await requireQuoteAccess(quoteId, "quotes.edit");
      if (!(await isModuleEnabled("suppliers"))) refuse("Suppliers is switched off for this workspace.");
      const actingTenant = await actingTenantId();
      const regional = await getRegionalSettings();

      // Same lock as saveQuoteDraft, which rewrites every line: a cost written mid-rewrite would be lost.
      const changed = await basePrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${quoteId} AND "tenantId" = ${actingTenant} FOR UPDATE`;
        const quote = await tx.quote.findFirst({
          where: { id: quoteId, tenantId: actingTenant },
          select: { number: true, deletedAt: true, supersededAt: true, currency: true, items: { select: { id: true, description: true, costCents: true } } },
        });
        if (!quote || quote.deletedAt) refuse("That quote is no longer there — refresh the page.");
        if (quote.supersededAt) refuse("A newer revision replaced this quote — put the costs on that one.");
        const currency = quote.currency ?? regional.currency; // NULL = the base
        const updates: { id: string; description: string; from: number; to: number }[] = [];
        for (const item of quote.items) {
          const raw = String(formData.get(`cost_${item.id}`) ?? "").trim();
          if (!raw) continue;
          const parsed = parseMoneyInput(raw, currency);
          if (!parsed.ok) refuse(`${item.description}: ${parsed.error}`);
          if (parsed.cents < 0) refuse(`${item.description}: a cost can't be negative.`);
          if (parsed.cents !== item.costCents) updates.push({ id: item.id, description: item.description, from: item.costCents, to: parsed.cents });
        }
        for (const update of updates) {
          await tx.quoteItem.updateMany({ where: { id: update.id, quoteId, tenantId: actingTenant }, data: { costCents: update.to } });
        }
        return { number: quote.number, updates };
      });

      if (changed.updates.length === 0) return { success: "No costs changed" };
      await logAudit({
        action: "quote.costs_set",
        summary: `Set costs on Q-${changed.number} from supplier quotes: ${changed.updates.map((u) => u.description).join(", ")}`,
        user,
        entityType: "Quote",
        entityId: quoteId,
      });
      revalidatePath(revalidate);
      return { success: `Cost saved on ${changed.updates.length} line${changed.updates.length === 1 ? "" : "s"}` };
    }),
  );
}
