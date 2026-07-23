export const PIPELINE_STAGE_ACTIONS = ["book_test_drive"] as const;

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
};

export function parsePipelineStageAction(
  value: string | null | undefined,
): PipelineStageAction | null {
  return PIPELINE_STAGE_ACTIONS.includes(value as PipelineStageAction)
    ? (value as PipelineStageAction)
    : null;
}
