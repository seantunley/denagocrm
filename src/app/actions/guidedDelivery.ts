"use server";

import { actingTenantId } from "@/lib/actingTenant";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { prisma } from "@/lib/db";
import { deliveryHandoverReadiness } from "@/lib/checklists/deliveryHandover";
import { requireModuleEnabled } from "@/lib/modules/enabled";
import { requireQuoteAccess } from "@/lib/permissions";
import { markDelivered } from "@/app/actions/fulfilment";

const SIGNATURE_PREFIX = "data:image/png;base64,";

/**
 * Finalise a delivery that is using the configurable guided-handover system.
 *
 * The UI only unlocks this after the checklist is complete, but that is not a
 * business invariant until the server repeats the check. This action therefore
 * re-authorises the quote, re-reads the active delivery templates and completed
 * runs in the acting tenant, requires the review/signature fields, and only then
 * delegates to the established markDelivered action for storage, audit and the
 * vehicle-registration redirect.
 */
export async function completeGuidedDelivery(
  quoteId: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await asActionResult(async () => {
    await requireModuleEnabled("automotive");
    await requireQuoteAccess(quoteId, "deliveries.manage");
    const tenantId = await actingTenantId();

    if (String(formData.get("deliveryNoteReviewed") ?? "") !== "yes") {
      refuse("Review the delivery note before asking the customer to sign.");
    }

    const deliveredByName = String(formData.get("deliveredByName") ?? "").trim();
    if (!deliveredByName) refuse("Enter who handed over the vehicle.");

    const signature = String(formData.get("signature") ?? "");
    if (!signature.startsWith(SIGNATURE_PREFIX)) {
      refuse("Ask the customer to sign before completing the delivery.");
    }
    const signatureBytes = Buffer.from(signature.slice(SIGNATURE_PREFIX.length), "base64");
    if (signatureBytes.length === 0) {
      refuse("Ask the customer to sign before completing the delivery.");
    }

    const templates = await prisma.checklistTemplate.findMany({
      where: { tenantId, host: "quote.delivery", active: true },
      select: { id: true, name: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    if (templates.length === 0) {
      refuse("No guided delivery handover is configured. Use the standard proof-of-delivery flow or set one up in Settings → Checklists.");
    }

    const runs = await prisma.checklistRun.findMany({
      where: {
        tenantId,
        hostType: "quote.delivery",
        hostId: quoteId,
        templateId: { in: templates.map((template) => template.id) },
      },
      select: { templateId: true, completedAt: true },
    });

    const readiness = deliveryHandoverReadiness(templates, runs);
    if (!readiness.ready) {
      const missingNames = templates
        .filter((template) => readiness.missingTemplateIds.includes(template.id))
        .map((template) => template.name);
      refuse(
        missingNames.length === 1
          ? `Finish “${missingNames[0]}” before the customer signs.`
          : `Finish the guided handover checklists before the customer signs: ${missingNames.join(", ")}.`,
      );
    }
  });

  if (gate.error || gate.redirectTo) return gate;
  return markDelivered(quoteId, formData);
}
