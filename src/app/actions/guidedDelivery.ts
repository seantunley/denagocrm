"use server";

import { actingTenantId } from "@/lib/actingTenant";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { prisma } from "@/lib/db";
import { deliveryHandoverReadiness } from "@/lib/checklists/deliveryHandover";
import { requireModuleEnabled } from "@/lib/modules/enabled";
import { requireQuoteAccess } from "@/lib/permissions";
import { markDelivered } from "@/app/actions/fulfilment";

const SIGNATURE_PREFIX = "data:image/png;base64,";
const MAX_SIGNATURE_BYTES = 4 * 1024 * 1024;

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
  // Filled inside the gate, read after it: the runs this delivery is signed
  // against, decided once at signing time rather than re-chosen on every render.
  let signedRunIds: string[] = [];
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
    // markDelivered intentionally accepts the legacy flow's optional signature,
    // so it skips an oversized image rather than refusing the whole delivery.
    // Guided completion requires a signature, which means silently dropping an
    // oversized one would violate the promise this screen makes to the customer.
    if (signatureBytes.length > MAX_SIGNATURE_BYTES) {
      refuse("That signature image is too large. Clear it and sign again.");
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
      // `id` and the ordering are what let this action PIN the runs being signed.
      // Newest-completed-first per template is the same rule the delivery note
      // used to re-evaluate on every render; evaluating it once, here, is what
      // stops it changing afterwards.
      select: { id: true, templateId: true, completedAt: true },
      orderBy: { completedAt: "desc" },
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

    /*
     * PIN THE RUNS, HERE, ONCE.
     *
     * The delivery note chose the newest completed run per template every time it
     * rendered. A delivery checklist is repeatable by design, so re-running one
     * after handover silently swapped the evidence shown beside a signature the
     * customer had already given: the document changed after it was signed. The
     * per-entry snapshots froze the template's WORDING and nothing froze WHICH
     * RUN.
     *
     * The same selection rule is evaluated once, at the moment of signing, and
     * the result is stored. `runs` is ordered newest-completed-first, so the
     * first completed run seen for a template is the one being signed against.
     */
    const signedByTemplate = new Map<string, string>();
    for (const run of runs) {
      if (!run.completedAt) continue;
      if (!signedByTemplate.has(run.templateId)) signedByTemplate.set(run.templateId, run.id);
    }
    signedRunIds = templates
      .map((template) => signedByTemplate.get(template.id))
      .filter((id): id is string => Boolean(id));
  });

  if (gate.error || gate.redirectTo) return gate;
  // Handed over server-to-server rather than through the form: this is evidence,
  // and a value the browser could set is not evidence. markDelivered re-verifies
  // every id against this quote and tenant, and writes them in the same update
  // that records the delivery — so a signed handover cannot exist without them.
  return markDelivered(quoteId, formData, signedRunIds);
}
