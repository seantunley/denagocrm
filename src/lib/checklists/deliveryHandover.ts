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
