import { addMonths, differenceInCalendarDays } from "date-fns";
import { parseTerms, termEnd } from "./warrantyParts";

export type WarrantyStatus = "active" | "expiring" | "expired" | "unknown";

const EXPIRING_DAYS = 60;

/**
 * The vehicle's warranty as one verdict. With parts (lib/warrantyParts.ts): in warranty while any part is — a lifetime
 * part (the chassis) keeps it in warranty for good — and otherwise until its last part ends. Without parts, the single
 * purchase date + warrantyMonths, exactly as before. Each part's own cover is on the vehicle page (vehicleCover).
 */
export function computeWarranty(
  v: { purchaseDate: Date | null; warrantyMonths: number | null; warrantyParts?: unknown; warrantyStartsAt?: Date | null },
  now = new Date()
): { status: WarrantyStatus; expiryDate: Date | null; daysRemaining: number | null } {
  const parts = parseTerms(v.warrantyParts);
  if (parts.length > 0 && v.warrantyStartsAt) {
    const ends = parts.map((p) => termEnd(v.warrantyStartsAt!, p.months));
    if (ends.some((end) => end === null)) return { status: "active", expiryDate: null, daysRemaining: null };
    return verdict(new Date(Math.max(...ends.map((end) => end!.getTime()))), now);
  }
  if (!v.purchaseDate || !v.warrantyMonths) {
    return { status: "unknown", expiryDate: null, daysRemaining: null };
  }
  return verdict(addMonths(v.purchaseDate, v.warrantyMonths), now);
}

function verdict(expiryDate: Date, now: Date): { status: WarrantyStatus; expiryDate: Date; daysRemaining: number } {
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
