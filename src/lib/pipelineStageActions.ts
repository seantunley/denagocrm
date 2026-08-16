/**
 * The stage actions a pipeline stage may require on entry.
 *
 * These are REMEDIES: each one is a rule the stage enforces plus a form that
 * satisfies it. The rule half, the criterion each one makes true and the
 * derivation for stages that carry no rule of their own all live in
 * `stageRemedies.ts`; this file stays import-free so the database's CHECK
 * constraint, the settings picker and the registry all name the same vocabulary.
 *
 * ADDING ONE IS FOUR COORDINATED CHANGES: this tuple, the metadata below, a
 * migration widening `PipelineStage_entryAction_check`, and the remedy's own
 * entry in `STAGE_REMEDIES` (with the dialog behind it). The constraint is
 * enforced only by the database — Prisma's DSL has no equivalent — so a value
 * added here without the migration fails at the INSERT.
 */
export const PIPELINE_STAGE_ACTIONS = ["book_test_drive", "link_contact"] as const;

export type PipelineStageAction = (typeof PIPELINE_STAGE_ACTIONS)[number];

export const PIPELINE_STAGE_ACTION_META: Record<
  PipelineStageAction,
  { label: string; shortLabel: string; description: string }
> = {
  book_test_drive: {
    label: "Book a test drive",
    shortLabel: "Test-drive booking",
    description:
      "Require a model, date, time and location, then create a test-drive activity.",
  },
  link_contact: {
    label: "Link a customer",
    shortLabel: "Customer link",
    description:
      "Require the lead to be linked to a customer record. Offers a picker when it is not.",
  },
};

export function parsePipelineStageAction(
  value: string | null | undefined,
): PipelineStageAction | null {
  return PIPELINE_STAGE_ACTIONS.includes(value as PipelineStageAction)
    ? (value as PipelineStageAction)
    : null;
}
