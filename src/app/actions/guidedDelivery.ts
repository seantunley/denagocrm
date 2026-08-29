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
     * THE RUNS THE CUSTOMER ACTUALLY REVIEWED — VERIFIED, NOT RE-DERIVED.
     *
     * "The newest completed run per template" is an answer that changes. It was
     * being asked twice: once by the delivery note when the customer previewed
     * it, and again HERE at submission. A colleague finishing another checklist
     * in between changed the answer, so the customer reviewed run A and their
     * signature was filed beside run B — the one defect a signature is supposed
     * to make impossible.
     *
     * The screen now asks once, drives the preview iframe with that answer, and
     * submits the same ids. They arrive through the browser, so they are checked
     * rather than trusted — but note what the check permits: only runs that
     * already belong to THIS quote in THIS tenant and are complete. The choice
     * space is exactly the set of legitimate answers, so a forged value can pick
     * a different one of the customer's own completed runs and nothing else.
     */
    const claimedRunIds = String(formData.get("runIds") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (claimedRunIds.length === 0) {
      refuse("Reload the delivery note and review it again before signing.");
    }

    const completedById = new Map(runs.filter((run) => run.completedAt).map((run) => [run.id, run]));
    const seenTemplates = new Set<string>();
    for (const id of claimedRunIds) {
      const run = completedById.get(id);
      // Not in the map means: not this quote's, not this tenant's, not against
      // an active delivery template, or not finished. All of them are "no".
      if (!run) {
        refuse("The delivery note has changed since it was reviewed. Reload it and review it again before signing.");
      }
      // One run per template, or the note would show a template twice and the
      // signature would cover an ambiguous document.
      if (seenTemplates.has(run.templateId)) {
        refuse("The delivery note has changed since it was reviewed. Reload it and review it again before signing.");
      }
      seenTemplates.add(run.templateId);
    }
    // Every active template must be covered. Readiness above proved a completed
    // run EXISTS for each; this proves the reviewed set actually names them, so
    // a short list cannot get a signature against a partial handover.
    if (templates.some((template) => !seenTemplates.has(template.id))) {
      refuse("The delivery note has changed since it was reviewed. Reload it and review it again before signing.");
    }

    signedRunIds = claimedRunIds;
  });

  if (gate.error || gate.redirectTo) return gate;
  // Handed over server-to-server rather than through the form: this is evidence,
  // and a value the browser could set is not evidence. markDelivered re-verifies
  // every id against this quote and tenant, and writes them in the same update
  // that records the delivery — so a signed handover cannot exist without them.
  return markDelivered(quoteId, formData, signedRunIds);
}
