// Client-safe battery-health analysis (no server-only imports).

export const BATTERY = {
  healthy: 80, // ≥ = green
  warning: 60, // ≥ = amber, below = red
  warrantyClaimSoh: 70, // at/below this within warranty → claim candidate
};

export type BatteryTone = "success" | "warning" | "danger" | "neutral";

export function sohTone(soh: number | null | undefined): BatteryTone {
  if (soh == null) return "neutral";
  if (soh >= BATTERY.healthy) return "success";
  if (soh >= BATTERY.warning) return "warning";
  return "danger";
}

type Check = { checkedAt: Date | string; stateOfHealth: number | null };

export type BatteryAnalysis = {
  latestSoh: number | null;
  degradationPerMonth: number | null; // %SoH lost per month
  projectedMonthsToWarning: number | null;
  warrantyEligible: boolean;
  replacementOpportunity: boolean;
  headline: string;
  tone: BatteryTone;
};

/** Analyse a vehicle's battery history (checks newest-first). */
export function analyzeBattery(
  checksDesc: Check[],
  opts: { purchaseDate?: Date | string | null; warrantyMonths?: number | null; now: Date },
): BatteryAnalysis {
  const withSoh = checksDesc.filter((c) => c.stateOfHealth != null);
  const latestSoh = withSoh[0]?.stateOfHealth ?? null;

  let degradationPerMonth: number | null = null;
  if (withSoh.length >= 2) {
    const newest = withSoh[0];
    const oldest = withSoh[withSoh.length - 1];
    const months = (new Date(newest.checkedAt).getTime() - new Date(oldest.checkedAt).getTime()) / (30 * 86_400_000);
    if (months > 0.2) {
      const drop = (oldest.stateOfHealth as number) - (newest.stateOfHealth as number);
      degradationPerMonth = Math.round((drop / months) * 100) / 100;
    }
  }

  let projectedMonthsToWarning: number | null = null;
  if (latestSoh != null && degradationPerMonth != null && degradationPerMonth > 0 && latestSoh > BATTERY.warning) {
    projectedMonthsToWarning = Math.round((latestSoh - BATTERY.warning) / degradationPerMonth);
  }

  let warrantyEligible = false;
  if (latestSoh != null && latestSoh <= BATTERY.warrantyClaimSoh && opts.purchaseDate && opts.warrantyMonths) {
    const end = new Date(opts.purchaseDate);
    end.setMonth(end.getMonth() + opts.warrantyMonths);
    warrantyEligible = opts.now <= end;
  }

  const replacementOpportunity = latestSoh != null && latestSoh < BATTERY.warning;

  let headline = "No battery data";
  if (latestSoh != null) {
    headline = replacementOpportunity
      ? "Replacement candidate"
      : latestSoh < BATTERY.healthy
        ? "Degrading — monitor"
        : "Healthy";
  }

  return {
    latestSoh,
    degradationPerMonth,
    projectedMonthsToWarning,
    warrantyEligible,
    replacementOpportunity,
    headline,
    tone: sohTone(latestSoh),
  };
}
