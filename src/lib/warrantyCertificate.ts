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
import { parseOwnershipWarranty } from "./vehicleTransferRules";

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

/**
 * Does the warranty cover the vehicle's owner NOW? Their open ownership row says so (lib/vehicleOwnership.ts): after a
 * transfer it can be pending approval or declined, while the vehicle's terms stay as they were. A vehicle with no row
 * reads as covered, as currentOwnershipWarranty does. Issue, send and DAX all refuse a certificate otherwise.
 */
export function ownerCovered(openRows: readonly { warranty: string }[]): boolean {
  return parseOwnershipWarranty(openRows[0]?.warranty) === "carried";
}

export const NOT_COVERED =
  "The warranty hasn't transferred to this vehicle's current owner (it is waiting for approval or was declined), so there's no certificate for them.";

/**
 * "WCERT-7F3K2A-2611-1A2B-3C4D-5E6F": the vehicle's short id, the issue month and 12 random hex characters of its own
 * (48 bits: two issues of one vehicle in one month share a number about once in 280 trillion), so every issue — a
 * reissue the same day included — has a number nobody else's has (reviews of #1173). Printed on the PDF, in its file
 * name and in the audit line.
 */
export function certificateNumber(vehicleId: string, issuedAt: Date, unique: string): string {
  const yymm = `${String(issuedAt.getFullYear()).slice(2)}${String(issuedAt.getMonth() + 1).padStart(2, "0")}`;
  const own = unique.replace(/[^a-z0-9]/gi, "").slice(0, 12).toUpperCase();
  if (own.length < 12) throw new Error("certificateNumber needs 12 random characters");
  return `WCERT-${vehicleId.slice(-6).toUpperCase()}-${yymm}-${own.match(/.{4}/g)!.join("-")}`;
}

/** One line per part: "Battery · 5 years · until 21 Nov 2031", "Chassis · Lifetime". */
export function partsLines(cover: readonly PartCover[], r: Regional = DEFAULT_REGIONAL): string {
  return cover.map((c) => [c.part, termLabel(c.months), c.until ? `until ${formatDate(c.until, r)}` : null].filter(Boolean).join(" · ")).join("\n");
}

export function certificateFileName(v: { model: string; regNumber: string | null; vin: string | null }, number: string): string {
  const ref = v.regNumber ?? v.vin;
  return `Warranty certificate ${number} — ${v.model}${ref ? ` ${ref}` : ""}.pdf`.replace(/[\\/:*?"<>|]+/g, " ");
}

export function buildWarrantyCertificateContext(
  v: CertificateVehicle,
  cover: readonly PartCover[],
  start: Date,
  issuedAt: Date,
  number: string,
  r: Regional = DEFAULT_REGIONAL,
): MergeContext {
  const c = v.contact;
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
    // The cover table (doceditor/warrantyCoverBlock.ts) reads these, already worded.
    warranty: {
      parts: cover.map((p) => ({ part: p.part, months: p.months, cover: termLabel(p.months), until: p.until ? formatDate(p.until, r) : "For life", lifetime: p.months == null })),
    },
    customer: { name: tokens["customer.name"], email: tokens["customer.email"], phone: tokens["customer.phone"] },
    vehicle: { model: v.model, vin: v.vin ?? "", reg: v.regNumber ?? "" },
  };
  return { tokens, items: [], vars };
}
