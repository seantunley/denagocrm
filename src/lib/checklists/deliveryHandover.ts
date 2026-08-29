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

export type HandoverCandidateRun = {
  id: string;
  templateId: string;
  completedAt: Date | string | null;
};

/**
 * WHICH RUNS THIS HANDOVER IS ABOUT — chosen ONCE, by one rule.
 *
 * A delivery checklist is repeatable, so "the newest completed run per
 * template" is an answer that changes. It was being asked twice: the delivery
 * note asked it when the customer previewed, and the completion action asked it
 * again at submission. Between those two moments a colleague finishing another
 * checklist changed the answer, and the customer reviewed run A while their
 * signature was filed beside run B.
 *
 * Asking once and carrying the ids through the review, the signature and the
 * write is what makes "the note they signed" a fact rather than a re-derivation.
 * The server still re-verifies the ids it is handed — see completeGuidedDelivery
 * — because they travel via the browser.
 *
 * Sorted here rather than relying on the caller's `orderBy`, so the two callers
 * cannot disagree by fetching in different orders.
 */
export function handoverRunSelection(
  templates: readonly DeliveryHandoverTemplate[],
  runs: readonly HandoverCandidateRun[],
): string[] {
  const time = (value: Date | string | null) => (value ? new Date(value).getTime() : 0);
  const newestFirst = runs
    .filter((run) => Boolean(run.completedAt))
    .slice()
    .sort((a, b) => time(b.completedAt) - time(a.completedAt));

  const chosen = new Map<string, string>();
  for (const run of newestFirst) {
    if (!chosen.has(run.templateId)) chosen.set(run.templateId, run.id);
  }
  // Template order, so the ids read the same way the note lays the sections out.
  return templates
    .map((template) => chosen.get(template.id))
    .filter((id): id is string => Boolean(id));
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
