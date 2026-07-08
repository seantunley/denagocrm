import { differenceInCalendarMonths } from "date-fns";

export type HealthTier = "vip" | "healthy" | "watch" | "at_risk";

export type HealthInput = {
  cartCount: number;
  wonCount: number;
  lastServiceAt: Date | null;
  lastContactAt: Date | null;
  referrals: number;
  openClaims: number;
  npsScore: number | null; // 0–10
  csatScore: number | null; // 1–5
};

export type HealthResult = { score: number; tier: HealthTier; reasons: string[] };

/**
 * A blended 0–100 customer-health score from ownership, service recency,
 * survey sentiment, referrals and open issues. Deliberately simple and
 * explainable — every point comes with a reason.
 */
export function computeHealth(input: HealthInput, now = new Date()): HealthResult {
  let score = 50;
  const reasons: string[] = [];

  if (input.cartCount >= 2) {
    score += 20;
    reasons.push(`Owns ${input.cartCount} carts`);
  } else if (input.cartCount === 1) {
    score += 12;
    reasons.push("Cart owner");
  }

  if (input.lastServiceAt) {
    const months = differenceInCalendarMonths(now, input.lastServiceAt);
    if (months <= 6) {
      score += 12;
      reasons.push("Serviced recently");
    } else if (months > 18) {
      score -= 25;
      reasons.push(`No service in ${months} months`);
    } else if (months > 12) {
      score -= 15;
      reasons.push("Overdue a service");
    }
  } else if (input.cartCount > 0) {
    score -= 8;
    reasons.push("Never serviced with us");
  }

  if (input.lastContactAt) {
    const months = differenceInCalendarMonths(now, input.lastContactAt);
    if (months <= 3) {
      score += 6;
    } else if (months > 12) {
      score -= 8;
      reasons.push("No recent contact");
    }
  }

  if (input.npsScore != null) {
    if (input.npsScore >= 9) {
      score += 18;
      reasons.push("NPS promoter");
    } else if (input.npsScore <= 6) {
      score -= 20;
      reasons.push("NPS detractor");
    }
  }
  if (input.csatScore != null) {
    if (input.csatScore >= 4) {
      score += 8;
      reasons.push("Happy with service");
    } else if (input.csatScore <= 2) {
      score -= 12;
      reasons.push("Low satisfaction");
    }
  }

  if (input.referrals > 0) {
    score += 10;
    reasons.push(`Referred ${input.referrals} ${input.referrals === 1 ? "person" : "people"}`);
  }
  if (input.openClaims > 0) {
    score -= 10;
    reasons.push("Open warranty claim");
  }
  if (input.wonCount > 0) score += 6;

  score = Math.max(0, Math.min(100, Math.round(score)));
  const tier: HealthTier =
    score >= 80 ? "vip" : score >= 60 ? "healthy" : score >= 40 ? "watch" : "at_risk";
  return { score, tier, reasons };
}

export const healthLabels: Record<HealthTier, string> = {
  vip: "VIP",
  healthy: "Healthy",
  watch: "Watch",
  at_risk: "At risk",
};

export const healthColors: Record<HealthTier, string> = {
  vip: "bg-emerald-500/15 text-emerald-300",
  healthy: "bg-sky-500/15 text-sky-300",
  watch: "bg-amber-500/15 text-amber-300",
  at_risk: "bg-red-500/15 text-red-300",
};
