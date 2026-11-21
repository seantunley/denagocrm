/**
 * The warranty certificate's merge fields (doceditor/standardTemplates.ts warrantyCertificateTemplate). Pure: the
 * database reads and the filing live in warrantyCertificateStore.ts.
 *
 * One certificate per vehicle per issue: a number from the vehicle and the issue time, the owner, the vehicle, and each
 * part's cover from the vehicle's own warranty (lib/warrantyParts.ts) — "Battery · 5 years · until 21 Nov 2031".
 */
import type { MergeContext } from "./docbuilder/merge";
import { contactName, DEFAULT_REGIONAL, formatDate, type Regional } from "./format";
import { termLabel, type PartCover } from "./warrantyParts";

export const CERTIFICATE_TAG = "warranty-certificate";

export type CertificateVehicle = {
  id: string;
  model: string;
  vin: string | null;
  regNumber: string | null;
  color: string | null;
  contact: {
    firstName: string;
    lastName?: string | null;
    company?: string | null;
    isCompany?: boolean;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    suburb?: string | null;
    city?: string | null;
  };
};

const lines = (...values: (string | null | undefined)[]) => values.filter(Boolean).join("\n");

/** "WCERT-7F3K2A-2611": the vehicle's short id and the issue month. */
export function certificateNumber(vehicleId: string, issuedAt: Date): string {
  const yymm = `${String(issuedAt.getFullYear()).slice(2)}${String(issuedAt.getMonth() + 1).padStart(2, "0")}`;
  return `WCERT-${vehicleId.slice(-6).toUpperCase()}-${yymm}`;
}

/** One line per part: "Battery · 5 years · until 21 Nov 2031", "Chassis · Lifetime". */
export function partsLines(cover: readonly PartCover[], r: Regional = DEFAULT_REGIONAL): string {
  return cover.map((c) => [c.part, termLabel(c.months), c.until ? `until ${formatDate(c.until, r)}` : null].filter(Boolean).join(" · ")).join("\n");
}

export function certificateFileName(v: { model: string; regNumber: string | null; vin: string | null }, number: string): string {
  const ref = v.regNumber ?? v.vin ?? number;
  return `Warranty certificate — ${v.model} ${ref}.pdf`.replace(/[\\/:*?"<>|]+/g, " ");
}

export function buildWarrantyCertificateContext(
  v: CertificateVehicle,
  cover: readonly PartCover[],
  start: Date,
  issuedAt: Date,
  r: Regional = DEFAULT_REGIONAL,
): MergeContext {
  const c = v.contact;
  const number = certificateNumber(v.id, issuedAt);
  const tokens: Record<string, string> = {
    "certificate.number": number,
    "certificate.date": formatDate(issuedAt, r),
    "customer.name": contactName(c),
    "customer.phone": c.phone ?? "",
    "customer.email": c.email ?? "",
    "customer.address": [c.address, c.suburb, c.city].filter(Boolean).join(", "),
    "customer.lines": lines(c.phone, c.email, [c.address, c.suburb, c.city].filter(Boolean).join(", ") || null),
    vehicle: v.model,
    "vehicle.vin": v.vin ?? "—",
    "vehicle.reg": v.regNumber ?? "—",
    "vehicle.color": v.color ?? "—",
    "vehicle.lines": lines(v.vin ? `VIN: ${v.vin}` : null, v.regNumber ? `Registration: ${v.regNumber}` : null, v.color ? `Colour: ${v.color}` : null),
    "warranty.start": formatDate(start, r),
    "warranty.partsLines": partsLines(cover, r),
    "date.today": formatDate(issuedAt, r),
  };
  const vars = {
    certificate: { number },
    warranty: { parts: cover.map((p) => ({ part: p.part, months: p.months, lifetime: p.months == null })) },
    customer: { name: tokens["customer.name"], email: tokens["customer.email"], phone: tokens["customer.phone"] },
    vehicle: { model: v.model, vin: v.vin ?? "", reg: v.regNumber ?? "" },
  };
  return { tokens, items: [], vars };
}
