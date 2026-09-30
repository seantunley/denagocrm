/**
 * Merge context for the delivery note and the service report when they print
 * from the single document editor.
 *
 * Pure on purpose: the record's own tokens ({{customer.*}}, {{quote.*}},
 * {{jobcard.*}}, {{company.*}}) come from bindCtx, exactly as for a quote. These
 * functions only add what those two printouts show on top, computed the same way
 * the fixed React pages compute it, so a template can reproduce them.
 */
import { formatDate } from "@/lib/format";
import type { RenderCtx } from "@/lib/doceditor/serialize";
import type { HandoverData } from "@/lib/doceditor/handoverChecklist";

type Ctx = NonNullable<RenderCtx>;

const lines = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join("\n");

export type DeliveryNoteFacts = {
  quoteNumber: number;
  deliveredAt: Date | null;
  deliveryScheduledFor: Date | null;
  deliveredByName: string | null;
  /** How many of the context's item rows are goods (the rest are fees). */
  lineCount: number;
  handover: HandoverData;
};

export function deliveryNoteContext(base: Ctx, f: DeliveryNoteFacts): Ctx {
  const t = base.tokens;
  const tokens: Record<string, string> = {
    "delivery.number": `DN-${f.quoteNumber}`,
    "delivery.date": formatDate(f.deliveredAt ?? f.deliveryScheduledFor ?? new Date()),
    "delivery.meta": [
      `Date: ${formatDate(f.deliveredAt ?? f.deliveryScheduledFor ?? new Date())}`,
      f.deliveredByName ? `Delivered by: ${f.deliveredByName}` : "",
      `Reference: Q-${f.quoteNumber}`,
    ].filter(Boolean).join(" · "),
    "delivery.deliverTo": lines(t["customer.attention"] && `Ask for: ${t["customer.attention"]}`, t["customer.phone"], t["customer.address"]),
    "delivery.details": lines(
      f.deliveryScheduledFor && `Scheduled: ${formatDate(f.deliveryScheduledFor)}`,
      f.deliveredAt ? `Delivered: ${formatDate(f.deliveredAt)}` : "Not yet delivered",
      f.deliveredByName && `Driver: ${f.deliveredByName}`,
    ),
    "delivery.driver": f.deliveredByName ?? "",
  };
  return {
    ...base,
    tokens: { ...t, ...tokens },
    // A delivery note is a packing list: the goods, not the fee rows.
    items: base.items.slice(0, f.lineCount),
    vars: {
      ...base.vars,
      delivery: { delivered: Boolean(f.deliveredAt), signed: Boolean(f.handover.signature), driver: f.deliveredByName ?? "" },
      handover: f.handover,
    },
  };
}

export type ServiceReportFacts = {
  jobCardNumber: number;
  serviceDate: Date | null;
  completedAt: Date | null;
  technician: string | null;
  km: number | null;
  vin: string | null;
  summary: string | null;
  details: string | null;
  nextDueDate: Date | null;
  nextDueKm: number | null;
};

export function serviceReportContext(base: Ctx, f: ServiceReportFacts): Ctx {
  const t = base.tokens;
  const nextDue = [
    f.nextDueDate ? formatDate(f.nextDueDate) : null,
    f.nextDueKm != null ? `${f.nextDueKm.toLocaleString()} km` : null,
  ].filter(Boolean).join(" or ");
  const tokens: Record<string, string> = {
    "service.number": `SR-${f.jobCardNumber}`,
    "service.date": formatDate(f.serviceDate ?? f.completedAt ?? new Date()),
    "service.technician": f.technician ?? "",
    "service.meta": [
      `Service date: ${formatDate(f.serviceDate ?? f.completedAt ?? new Date())}`,
      f.technician ? `Technician: ${f.technician}` : "",
      `Job card #${f.jobCardNumber}`,
    ].filter(Boolean).join(" · "),
    "service.customerLines": lines(t["customer.phone"], t["customer.email"]),
    "service.vehicleLines": lines(f.vin && `VIN: ${f.vin}`, f.km != null && `Odometer: ${f.km.toLocaleString()} km`),
    "service.odometer": f.km != null ? `${f.km.toLocaleString()} km` : "",
    "service.summary": f.summary ?? "",
    "service.details": f.details ?? "",
    "service.work": lines(f.summary, f.details),
    "service.nextDue": nextDue,
  };
  return {
    ...base,
    tokens: { ...t, ...tokens },
    vars: {
      ...base.vars,
      service: { hasSummary: Boolean(f.summary), hasNextDue: Boolean(nextDue), km: f.km },
    },
  };
}
