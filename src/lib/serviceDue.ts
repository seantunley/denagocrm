import { addMonths, differenceInCalendarDays } from "date-fns";

export type DueStatus = "overdue" | "due_soon" | "ok" | "unknown";

export type VehicleForDue = {
  serviceIntervalKm: number | null;
  serviceIntervalMonths: number | null;
  purchaseDate: Date | null;
  serviceRecords: {
    serviceDate: Date;
    km: number | null;
    nextDueKm: number | null;
    nextDueDate: Date | null;
  }[];
  mileageLogs: { km: number; recordedAt: Date }[];
};

export type DueInfo = {
  status: DueStatus;
  nextDueDate: Date | null;
  nextDueKm: number | null;
  currentKm: number | null;
  kmRemaining: number | null;
  daysRemaining: number | null;
};

const DUE_SOON_DAYS = 30;
const DUE_SOON_KM = 200;

/**
 * Computes when the next service is due. Explicit nextDue values on the
 * latest service record win; otherwise fall back to the vehicle's
 * interval settings applied from the last service (or purchase date).
 */
export function computeDue(vehicle: VehicleForDue, now = new Date()): DueInfo {
  const lastService = [...vehicle.serviceRecords].sort(
    (a, b) => b.serviceDate.getTime() - a.serviceDate.getTime()
  )[0];
  const latestMileage = [...vehicle.mileageLogs].sort(
    (a, b) => b.recordedAt.getTime() - a.recordedAt.getTime()
  )[0];
  const currentKm = latestMileage?.km ?? lastService?.km ?? null;

  let nextDueDate: Date | null = lastService?.nextDueDate ?? null;
  let nextDueKm: number | null = lastService?.nextDueKm ?? null;

  if (!nextDueDate && vehicle.serviceIntervalMonths) {
    const base = lastService?.serviceDate ?? vehicle.purchaseDate;
    if (base) nextDueDate = addMonths(base, vehicle.serviceIntervalMonths);
  }
  if (nextDueKm == null && vehicle.serviceIntervalKm) {
    const baseKm = lastService?.km ?? 0;
    nextDueKm = baseKm + vehicle.serviceIntervalKm;
  }

  const daysRemaining = nextDueDate
    ? differenceInCalendarDays(nextDueDate, now)
    : null;
  const kmRemaining =
    nextDueKm != null && currentKm != null ? nextDueKm - currentKm : null;

  let status: DueStatus = "unknown";
  if (daysRemaining != null || kmRemaining != null) {
    if (
      (daysRemaining != null && daysRemaining < 0) ||
      (kmRemaining != null && kmRemaining < 0)
    ) {
      status = "overdue";
    } else if (
      (daysRemaining != null && daysRemaining <= DUE_SOON_DAYS) ||
      (kmRemaining != null && kmRemaining <= DUE_SOON_KM)
    ) {
      status = "due_soon";
    } else {
      status = "ok";
    }
  }

  return { status, nextDueDate, nextDueKm, currentKm, kmRemaining, daysRemaining };
}

export const dueLabels: Record<DueStatus, string> = {
  overdue: "Overdue",
  due_soon: "Due soon",
  ok: "OK",
  unknown: "Unknown",
};

export const dueColors: Record<DueStatus, string> = {
  overdue: "bg-red-500/15 text-red-300",
  due_soon: "bg-amber-500/15 text-amber-300",
  ok: "bg-emerald-500/15 text-emerald-300",
  unknown: "bg-slate-800 text-slate-400",
};
