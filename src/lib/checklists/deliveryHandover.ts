export type DeliveryHandoverTemplate = { id: string };
export type DeliveryHandoverRun = { templateId: string; completedAt: unknown | null };

export type DeliveryHandoverReadiness = {
  configured: boolean;
  ready: boolean;
  missingTemplateIds: string[];
};

/**
 * One rule for both the Deliveries UI and the server-side completion gate.
 *
 * A guided delivery is ready to sign only when every ACTIVE delivery-handover
 * template has at least one completed run against this quote. If no template is
 * configured, the guided flow is deliberately considered unavailable rather
 * than silently pretending that an empty checklist is complete; the Deliveries
 * page can then fall back to the legacy proof-of-delivery control.
 */
export function deliveryHandoverReadiness(
  templates: readonly DeliveryHandoverTemplate[],
  runs: readonly DeliveryHandoverRun[],
): DeliveryHandoverReadiness {
  if (templates.length === 0) {
    return { configured: false, ready: false, missingTemplateIds: [] };
  }

  const completedTemplateIds = new Set(
    runs.filter((run) => Boolean(run.completedAt)).map((run) => run.templateId),
  );
  const missingTemplateIds = templates
    .map((template) => template.id)
    .filter((templateId) => !completedTemplateIds.has(templateId));

  return {
    configured: true,
    ready: missingTemplateIds.length === 0,
    missingTemplateIds,
  };
}

export type DeliveryNoteRun = {
  id: string;
  templateId: string;
  completedAt: unknown | null;
  template: { sortOrder: number };
};

/**
 * The runs a delivery note may show.
 *
 * ONCE SIGNED, THIS IS ALREADY DECIDED. The note used to choose the newest
 * completed run per template on every render, and a delivery checklist is
 * repeatable by design — so re-running one AFTER handover silently replaced the
 * evidence beside a signature the customer had already given. The document
 * changed after it was signed. Per-entry snapshots froze the template's WORDING;
 * nothing froze WHICH RUN.
 *
 * `signedRunIds` is recorded by completeGuidedDelivery at the moment of signing.
 * Where it exists it is the whole answer, and a newer run cannot displace it.
 *
 * Empty means either a delivery completed before those ids existed, or a note
 * that has not been signed yet. Both keep the previous selection: the first
 * reproduces exactly what it renders today, and the second has nothing frozen to
 * honour yet.
 */
export function deliveryNoteRuns<T extends DeliveryNoteRun>(
  runs: readonly T[],
  signedRunIds: readonly string[],
): T[] {
  const bySortOrder = (a: T, b: T) => a.template.sortOrder - b.template.sortOrder;

  if (signedRunIds.length > 0) {
    const signed = new Set(signedRunIds);
    return runs.filter((run) => signed.has(run.id)).sort(bySortOrder);
  }

  const latestByTemplate = new Map<string, T>();
  for (const run of runs) {
    if (!run.completedAt) continue;
    if (!latestByTemplate.has(run.templateId)) latestByTemplate.set(run.templateId, run);
  }
  return [...latestByTemplate.values()].sort(bySortOrder);
}
