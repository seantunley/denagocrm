/** Shared form rules. Nurture interests also cover products not yet in the catalogue. */
export const NURTURE_REASONS = {
  product: "Waiting for suitable product",
  timing: "Buying later",
  budget: "Budget not ready",
  customer: "Customer requested a pause",
  other: "Other future interest",
} as const;

export function nurtureReasonLabel(reason: string | null) {
  return NURTURE_REASONS[reason as keyof typeof NURTURE_REASONS] ?? reason ?? "Future interest";
}

export function reviewDate(value: string, now = new Date()): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T09:00:00+02:00`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  const today = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return value >= today ? date : null;
}

export function parseNurtureForm(form: FormData, now = new Date()): {
  reason: string; interest: string; trigger: string; reviewAt: Date; assignedToId: string;
} | { error: string } {
  const read = (key: string) => String(form.get(key) ?? "").trim();
  const reason = read("reason");
  const interest = read("interest").replace(/\s+/g, " ");
  const trigger = read("trigger");
  const reviewAt = reviewDate(read("reviewDate"), now);
  const assignedToId = read("assignedToId");
  if (!Object.hasOwn(NURTURE_REASONS, reason)) return { error: "Choose a nurture reason." } as const;
  if (!interest || interest.length > 120) return { error: "Enter a product or interest, up to 120 characters." } as const;
  if (trigger.length < 3 || trigger.length > 500) return { error: "Describe when to follow up, using 3–500 characters." } as const;
  if (!reviewAt) return { error: "Choose a valid review date today or later." } as const;
  if (!assignedToId) return { error: "Choose a responsible salesperson." } as const;
  return { reason, interest, trigger, reviewAt, assignedToId } as const;
}

export const clearedNurture = {
  nurtureSince: null, nurtureReason: null, nurtureInterest: null,
  nurtureTrigger: null, nurtureReviewAt: null, nurtureActivityId: null,
};
