/**
 * Merge contexts for the two documents that are bound to neither a quote nor a
 * job card: the test-drive indemnity (a LEAD) and the warranty claim (a
 * WarrantyClaim). Pure — the database reads live in leadWarrantyRecords.ts — so
 * the token set can be asserted directly.
 *
 * The tokens are what the legacy print pages show, under the names the existing
 * seeded layouts already use ({{customer.*}}, {{vehicle}}, {{vehicle.vin}},
 * {{date.today}}), so a template seeded before this existed binds too.
 * `*.lines` tokens are the multi-line info-card bodies with empty lines dropped,
 * exactly as the legacy InfoBlock filtered them.
 */
import type { MergeContext } from "./merge";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { computeWarranty, warrantyLabels } from "@/lib/warranty";
import { jobLineCents } from "@/lib/workshop-constants";

type ContactForDoc = {
  firstName: string;
  lastName?: string | null;
  company?: string | null;
  isCompany?: boolean;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  suburb?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
};

export type LeadForDoc = {
  title: string;
  name: string;
  phone: string | null;
  email: string | null;
  color: string | null;
  status: string;
  source: string;
  product: { name: string } | null;
  contact: ContactForDoc | null;
};

export type WarrantyClaimForDoc = {
  id: string;
  status: string;
  description: string;
  resolution: string | null;
  claimedAt: Date;
  resolvedAt: Date | null;
  vehicle: {
    model: string;
    vin: string | null;
    regNumber: string | null;
    color: string | null;
    purchaseDate: Date | null;
    warrantyMonths: number | null;
    contact: ContactForDoc;
  };
};

export type WarrantyPartForDoc = {
  kind: string;
  description: string;
  qty: number;
  unitPriceCents: number;
};

const lines = (...values: (string | null | undefined)[]) => values.filter(Boolean).join("\n");

const addressOf = (c: ContactForDoc | null) =>
  c ? [c.address, c.suburb, c.city, c.province, c.postalCode].filter(Boolean).join(", ") : "";

/** Test-drive indemnity: the driver (lead), the vehicle of interest, today's date. */
export function buildLeadContext(lead: LeadForDoc, now = new Date()): MergeContext {
  const vehicle = lead.product?.name ?? "Denago EV";
  const tokens: Record<string, string> = {
    "customer.name": lead.name,
    "customer.phone": lead.phone ?? "",
    "customer.email": lead.email ?? "",
    "customer.address": addressOf(lead.contact),
    "customer.lines": lines(lead.phone, lead.email),
    "lead.title": lead.title,
    "lead.name": lead.name,
    "lead.status": lead.status,
    "lead.source": lead.source,
    vehicle,
    "vehicle.color": lead.color ?? "",
    "vehicle.lines": lines(lead.color ? `Colour: ${lead.color}` : null),
    "date.today": formatDate(now),
  };
  const vars = {
    lead: { name: lead.name, status: lead.status, source: lead.source, hasContact: Boolean(lead.contact) },
    customer: { name: lead.name, email: tokens["customer.email"], phone: tokens["customer.phone"] },
    vehicle: { model: vehicle, color: tokens["vehicle.color"] },
  };
  return { tokens, items: [], vars };
}

/**
 * Warranty claim: the claim, its vehicle and warranty standing, the owner, the
 * reported fault and resolution. `parts` are the lines of the claim's linked job
 * card, if any — the legacy printout never showed them, so they only appear if a
 * layout adds a Line items block.
 */
export function buildWarrantyContext(
  claim: WarrantyClaimForDoc,
  parts: WarrantyPartForDoc[] = [],
  now = new Date(),
): MergeContext {
  const v = claim.vehicle;
  const w = computeWarranty(v, now);
  const warrantySummary = `Warranty: ${warrantyLabels[w.status]}${w.expiryDate ? ` (until ${formatDate(w.expiryDate)})` : ""}`;
  const resolutionLine = claim.resolution
    ? `${claim.resolution}${claim.resolvedAt ? ` (${formatDate(claim.resolvedAt)})` : ""}`
    : "";
  const tokens: Record<string, string> = {
    "customer.name": contactName(v.contact),
    "customer.phone": v.contact.phone ?? "",
    "customer.email": v.contact.email ?? "",
    "customer.address": addressOf(v.contact),
    "customer.lines": lines(v.contact.phone, v.contact.email),
    "claim.number": `WC-${claim.id.slice(-6).toUpperCase()}`,
    "claim.status": claim.status,
    "claim.date": formatDate(claim.claimedAt),
    "claim.description": claim.description,
    "claim.resolution": claim.resolution ?? "",
    "claim.resolvedAt": claim.resolvedAt ? formatDate(claim.resolvedAt) : "—",
    "claim.resolutionLine": resolutionLine,
    vehicle: v.model,
    "vehicle.vin": v.vin ?? "—",
    "vehicle.reg": v.regNumber ?? "—",
    "vehicle.color": v.color ?? "—",
    "vehicle.purchased": v.purchaseDate ? formatDate(v.purchaseDate) : "—",
    "vehicle.lines": lines(
      v.vin ? `VIN: ${v.vin}` : null,
      v.purchaseDate ? `Purchased: ${formatDate(v.purchaseDate)}` : null,
      warrantySummary,
    ),
    "warranty.status": warrantyLabels[w.status],
    "warranty.expiry": w.expiryDate ? formatDate(w.expiryDate) : "—",
    "warranty.summary": warrantySummary,
    "date.today": formatDate(now),
  };
  const items = parts.map((p) => ({
    cells: [
      { value: `${p.kind === "labour" ? "Labour — " : ""}${p.description}` },
      { value: String(p.qty) },
      { value: formatZAR(p.unitPriceCents) },
      { value: formatZAR(jobLineCents(p)) },
    ],
  }));
  const vars = {
    claim: {
      status: claim.status,
      hasResolution: Boolean(claim.resolution),
      parts: parts.map((p) => ({ description: p.description, kind: p.kind, qty: p.qty })),
    },
    warranty: { status: w.status, daysRemaining: w.daysRemaining },
    customer: { name: tokens["customer.name"], email: tokens["customer.email"], phone: tokens["customer.phone"] },
    vehicle: { model: v.model, vin: v.vin ?? "", reg: v.regNumber ?? "" },
  };
  return { tokens, items, vars };
}
