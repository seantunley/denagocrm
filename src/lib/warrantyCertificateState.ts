import { createHash } from "node:crypto";
import { contactName } from "./format";
import { vehicleCover } from "./warrantyParts";
import { NOT_COVERED, ownerCovered } from "./warrantyCertificate";

/**
 * Is a filed warranty certificate still the vehicle's certificate? (Reviews of #1174.) It is only while it is made out to
 * the owner NOW and was made from the vehicle's warranty and details as they are NOW. After a transfer it names the
 * previous owner; after a warranty edit (Cart 2 → 3 years) its PDF says the old terms. Either way it is never sent or
 * offered as current — it is reissued first. Used by the email send, DAX's lookup, DAX's WhatsApp send and the vehicle
 * page.
 */

/** Every owner and vehicle detail a certificate can print (buildWarrantyCertificateContext) — all required, so every
 * reader selects them all and the fingerprint never differs for a field left out. */
export type CertificateFacts = {
  contactId: string;
  model: string;
  vin: string | null;
  regNumber: string | null;
  color: string | null;
  purchaseDate: Date | null;
  warrantyMonths: number | null;
  warrantyParts: unknown;
  warrantyStartsAt: Date | null;
  contact: {
    firstName: string; lastName: string | null; company: string | null; isCompany: boolean;
    phone: string | null; email: string | null; address: string | null; suburb: string | null; city: string | null;
  };
};

/** The current owner's open ownership row (lib/vehicleOwnership.ts): whether the warranty transferred to them. */
export type OwnershipFacts = { ownerships: readonly { warranty: string }[] };

export type CertificateState = "current" | "previous_owner" | "not_covered" | "out_of_date";

const EPOCH = new Date(0);

/** A fingerprint of what the certificate prints about the owner, the vehicle and its cover. Stored as Document.issuedFrom. */
export function certificateFingerprint(v: CertificateFacts): string {
  const c = v.contact;
  const start = v.warrantyStartsAt ?? v.purchaseDate;
  const terms = vehicleCover(v, EPOCH).map((p) => [p.part, p.months]);
  const owner = [v.contactId, contactName(c), c.phone, c.email, c.address, c.suburb, c.city];
  return createHash("sha256")
    .update(JSON.stringify([owner, v.model, v.vin, v.regNumber, v.color, start?.getTime() ?? null, terms]))
    .digest("hex")
    .slice(0, 32);
}

export function certificateState(cert: { contactId: string | null; issuedFrom: string | null }, v: CertificateFacts & OwnershipFacts): CertificateState {
  if (cert.contactId !== v.contactId) return "previous_owner";
  // The warranty didn't transfer to this owner (pending approval or declined): no certificate is theirs to have.
  if (!ownerCovered(v.ownerships)) return "not_covered";
  return cert.issuedFrom === certificateFingerprint(v) ? "current" : "out_of_date";
}

/** Why a filed certificate can't be sent, said to staff (Send refusal) and to DAX (lookup). */
export const CERTIFICATE_NOT_CURRENT: Record<Exclude<CertificateState, "current">, string> = {
  previous_owner: "The filed certificate names a previous owner. Issue a new certificate for the current owner first.",
  not_covered: NOT_COVERED,
  out_of_date: "The vehicle's warranty, its details or the owner's details changed after the filed certificate was issued. Reissue it first.",
};

/**
 * Select this with a vehicle to check its certificate: the facts above plus its open ownership row (through the
 * vehicle's own relation, so only that vehicle's rows).
 */
export const CERTIFICATE_FACTS_SELECT = {
  contactId: true, model: true, vin: true, regNumber: true, color: true,
  purchaseDate: true, warrantyMonths: true, warrantyParts: true, warrantyStartsAt: true,
  contact: { select: { firstName: true, lastName: true, company: true, isCompany: true, phone: true, email: true, address: true, suburb: true, city: true } },
  ownerships: { where: { ownedUntil: null }, select: { warranty: true }, take: 1 },
} as const;
