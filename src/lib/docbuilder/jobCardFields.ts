import { formatDate } from "@/lib/format";
import { stageMeta } from "@/lib/workshop-constants";

/** What the printed job card shows beyond the base job-card merge context. */
export type JobCardPrintSource = {
  status: string;
  openedAt: Date;
  completedAt: Date | null;
  kmIn: number | null;
  notes: string | null;
  signedAt: Date | null;
  signedByName: string | null;
  signerIp: string | null;
  vehicle: { model: string; color: string | null; vin: string | null; regNumber: string | null };
  serviceRecord?: {
    summary: string;
    details: string | null;
    km: number | null;
    nextDueDate: Date | null;
    nextDueKm: number | null;
    performedBy: { name: string } | null;
  } | null;
};

/**
 * Tokens and conditional vars that let a builder layout say everything the
 * fixed job-card printout (app/(print)/jobcards/[id]/print) says, worded the same
 * way. Pure, so the wording is testable; additive to buildJobCardContext.
 *
 * `signatureSrc` is the stored customer signature already embedded as a data URL
 * (embedStoredImage) — a private-store link would not load on paper.
 */
export function jobCardPrintFields(jc: JobCardPrintSource, signatureSrc?: string | null) {
  const v = jc.vehicle;
  const dates =
    `Opened ${formatDate(jc.openedAt)}` +
    (jc.kmIn != null ? ` · ${jc.kmIn.toLocaleString()} km in` : "") +
    (jc.completedAt ? ` · Completed ${formatDate(jc.completedAt)}` : "");
  const sr = jc.serviceRecord ?? null;
  const tokens: Record<string, string> = {
    "jobcard.stage": stageMeta(jc.status).label,
    "jobcard.dates": dates,
    "vehicle.title": `${v.model}${v.color ? ` — ${v.color}` : ""}`,
    "vehicle.lines": [v.vin && `VIN / Serial: ${v.vin}`, v.regNumber && `Reg: ${v.regNumber}`, dates].filter(Boolean).join("\n"),
    "service.line": sr
      ? `${sr.summary}${sr.km != null ? ` · at ${sr.km.toLocaleString()} km` : ""}${sr.performedBy ? ` · Technician: ${sr.performedBy.name}` : ""}`
      : "",
    "service.details": sr?.details ?? "",
    "service.nextDue": sr
      ? `${sr.nextDueDate ? formatDate(sr.nextDueDate) : "—"}${sr.nextDueKm != null ? ` / ${sr.nextDueKm.toLocaleString()} km` : ""}`
      : "",
    "jobcard.signedLine": jc.signedAt
      ? `Signed electronically by ${jc.signedByName ?? ""} on ${formatDate(jc.signedAt)}${jc.signerIp ? ` · IP ${jc.signerIp}` : ""} · ECT Act, 2002`
      : "",
    "jobcard.signature": jc.signedAt ? signatureSrc ?? "" : "",
    // The printout's "Generated …" date. A signing snapshot freezes its own.
    "date.today": formatDate(new Date()),
  };
  const vars = {
    signed: Boolean(jc.signedAt),
    hasNotes: Boolean(jc.notes?.trim()),
    hasService: Boolean(sr),
    hasServiceDetails: Boolean(sr?.details),
  };
  return { tokens, vars };
}
