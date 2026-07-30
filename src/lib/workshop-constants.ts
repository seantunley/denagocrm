// Client-safe workshop constants (no server-only imports).

export type StageTone = "neutral" | "info" | "warning" | "success" | "danger";

export type Stage =
  | "booking"
  | "checkin"
  | "diagnosis"
  | "approval"
  | "repair"
  | "qc"
  | "ready"
  | "collected"
  | "cancelled";

export type StageMeta = { value: Stage; label: string; tone: StageTone; terminal: boolean };

/** Every stage, in workflow order (cancelled is an off-path terminal). */
export const STAGES: StageMeta[] = [
  { value: "booking", label: "Booking", tone: "neutral", terminal: false },
  { value: "checkin", label: "Check-in", tone: "info", terminal: false },
  { value: "diagnosis", label: "Diagnosis", tone: "info", terminal: false },
  { value: "approval", label: "Approval", tone: "warning", terminal: false },
  { value: "repair", label: "Repair", tone: "info", terminal: false },
  { value: "qc", label: "Quality check", tone: "info", terminal: false },
  { value: "ready", label: "Ready for collection", tone: "success", terminal: false },
  { value: "collected", label: "Collected", tone: "success", terminal: true },
  { value: "cancelled", label: "Cancelled", tone: "danger", terminal: true },
];

/** The linear pipeline a job normally walks, booking → ready (excludes terminals). */
export const PIPELINE_STAGES: StageMeta[] = STAGES.filter(
  (s) => !s.terminal,
);

export const STAGE_VALUES: string[] = STAGES.map((s) => s.value);

const STAGE_BY_VALUE = new Map(STAGES.map((s) => [s.value, s]));

export function stageMeta(value: string): StageMeta {
  return (
    STAGE_BY_VALUE.get(value as Stage) ?? {
      value: value as Stage,
      label: value.replace(/_/g, " "),
      tone: "neutral",
      terminal: false,
    }
  );
}

export function isTerminalStage(value: string): boolean {
  return stageMeta(value).terminal;
}

/** The next stage in the pipeline, or null at/after "ready". */
export function nextStage(value: string): StageMeta | null {
  const idx = PIPELINE_STAGES.findIndex((s) => s.value === value);
  if (idx === -1 || idx >= PIPELINE_STAGES.length - 1) return null;
  return PIPELINE_STAGES[idx + 1];
}

export type PriorityMeta = { value: string; label: string; tone: StageTone };

export const PRIORITIES: PriorityMeta[] = [
  { value: "urgent", label: "Urgent", tone: "danger" },
  { value: "high", label: "High", tone: "warning" },
  { value: "normal", label: "Normal", tone: "neutral" },
  { value: "low", label: "Low", tone: "info" },
];

export const PRIORITY_VALUES: string[] = PRIORITIES.map((p) => p.value);

export function priorityMeta(value: string): PriorityMeta {
  return PRIORITIES.find((p) => p.value === value) ?? { value, label: value, tone: "neutral" };
}

export const INSPECTION_STATUSES: { value: string; label: string; tone: StageTone }[] = [
  { value: "ok", label: "OK", tone: "success" },
  { value: "attention", label: "Attention", tone: "warning" },
  { value: "fail", label: "Fail", tone: "danger" },
  { value: "na", label: "N/A", tone: "neutral" },
];

export function inspectionStatusMeta(value: string): { value: string; label: string; tone: StageTone } {
  return INSPECTION_STATUSES.find((s) => s.value === value) ?? { value, label: value, tone: "neutral" };
}

export const APPROVAL_STATUS_TONE: Record<string, StageTone> = {
  pending: "warning",
  approved: "success",
  declined: "danger",
};

/** Default workshop labour rate (rands) when no AppSetting / per-job override is set. */
export const DEFAULT_LABOUR_RATE_CENTS = 65000; // R650/hour

/** Hours between two instants, rounded to 2 dp. */
export function hoursBetween(start: Date | string, end: Date | string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.max(0, Math.round((ms / 3_600_000) * 100) / 100);
}

// ── Job card money ────────────────────────────────────────────────────────────

export type JobCardLine = { kind: string; qty: number; unitPriceCents: number };

/**
 * One line's charge in cents. Labour quantities are fractional (1.5 hours), so
 * a line can land on a half-cent — round once, here, so every document reaches
 * the same figure instead of differing by a cent depending on where it rounded.
 */
export function jobLineCents(line: JobCardLine): number {
  return Math.round(line.qty * line.unitPriceCents);
}

export type JobCardTotals = {
  partsCents: number;
  labourCents: number;
  otherCents: number;
  totalCents: number;
};

/**
 * What the customer is charged for a job, and how it breaks down.
 *
 * `totalCents` counts EVERY line whatever its kind. `kind` is a free-text
 * column with a default, and totalling only "part" + "labour" — which the
 * record page, the printed job card, the builder documents and the profit
 * report each did separately — silently drops any other line while the items
 * table still prints it, leaving a document whose rows don't add up to its own
 * total. `otherCents` keeps that remainder visible rather than losing it.
 */
export function jobCardTotals(lines: JobCardLine[]): JobCardTotals {
  let partsCents = 0;
  let labourCents = 0;
  let otherCents = 0;
  for (const line of lines) {
    const cents = jobLineCents(line);
    if (line.kind === "part") partsCents += cents;
    else if (line.kind === "labour") labourCents += cents;
    else otherCents += cents;
  }
  return { partsCents, labourCents, otherCents, totalCents: partsCents + labourCents + otherCents };
}
