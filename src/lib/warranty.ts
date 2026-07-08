import { addMonths, differenceInCalendarDays } from "date-fns";

export type WarrantyStatus = "active" | "expiring" | "expired" | "unknown";

const EXPIRING_DAYS = 60;

export function computeWarranty(
  v: { purchaseDate: Date | null; warrantyMonths: number | null },
  now = new Date()
): { status: WarrantyStatus; expiryDate: Date | null; daysRemaining: number | null } {
  if (!v.purchaseDate || !v.warrantyMonths) {
    return { status: "unknown", expiryDate: null, daysRemaining: null };
  }
  const expiryDate = addMonths(v.purchaseDate, v.warrantyMonths);
  const daysRemaining = differenceInCalendarDays(expiryDate, now);
  const status: WarrantyStatus =
    daysRemaining < 0 ? "expired" : daysRemaining <= EXPIRING_DAYS ? "expiring" : "active";
  return { status, expiryDate, daysRemaining };
}

export const warrantyLabels: Record<WarrantyStatus, string> = {
  active: "In warranty",
  expiring: "Expiring soon",
  expired: "Out of warranty",
  unknown: "No warranty info",
};

export const warrantyColors: Record<WarrantyStatus, string> = {
  active: "bg-emerald-500/15 text-emerald-300",
  expiring: "bg-amber-500/15 text-amber-300",
  expired: "bg-slate-800 text-slate-400",
  unknown: "bg-slate-800 text-slate-500",
};

export const claimStatuses = ["open", "approved", "rejected", "resolved"] as const;
export type ClaimStatus = (typeof claimStatuses)[number];

export const claimColors: Record<string, string> = {
  open: "bg-sky-500/15 text-sky-300",
  approved: "bg-emerald-500/15 text-emerald-300",
  rejected: "bg-red-500/15 text-red-300",
  resolved: "bg-slate-800 text-slate-400",
};
