import { createHash } from "node:crypto";
import { contactName } from "./format";
import { vehicleCover } from "./warrantyParts";

/**
 * Is a filed warranty certificate still the vehicle's certificate? (Reviews of #1174.) It is only while it is made out to
 * the owner NOW and was made from the vehicle's warranty and details as they are NOW. After a transfer it names the
 * previous owner; after a warranty edit (Cart 2 → 3 years) its PDF says the old terms. Either way it is never sent or
 * offered as current — it is reissued first. Used by the email send, DAX's lookup, DAX's WhatsApp send and the vehicle
 * page.
 */

export type CertificateFacts = {
  contactId: string;
  model: string;
  vin: string | null;
  color: string | null;
  purchaseDate: Date | null;
  warrantyMonths: number | null;
  warrantyParts: unknown;
  warrantyStartsAt: Date | null;
  contact: { firstName: string; lastName?: string | null; company?: string | null; isCompany?: boolean };
};

export type CertificateState = "current" | "previous_owner" | "out_of_date";

const EPOCH = new Date(0);

/** A fingerprint of what the certificate prints about the owner, the vehicle and its cover. Stored as Document.issuedFrom. */
export function certificateFingerprint(v: CertificateFacts): string {
  const start = v.warrantyStartsAt ?? v.purchaseDate;
  const terms = vehicleCover(v, EPOCH).map((p) => [p.part, p.months]);
  return createHash("sha256")
    .update(JSON.stringify([v.contactId, contactName(v.contact), v.model, v.vin, v.color, start?.getTime() ?? null, terms]))
    .digest("hex")
    .slice(0, 32);
}

export function certificateState(cert: { contactId: string | null; issuedFrom: string | null }, v: CertificateFacts): CertificateState {
  if (cert.contactId !== v.contactId) return "previous_owner";
  return cert.issuedFrom === certificateFingerprint(v) ? "current" : "out_of_date";
}

/** Why a filed certificate can't be sent, said to staff (Send refusal) and to DAX (lookup). */
export const CERTIFICATE_NOT_CURRENT: Record<Exclude<CertificateState, "current">, string> = {
  previous_owner: "The filed certificate names a previous owner. Issue a new certificate for the current owner first.",
  out_of_date: "The vehicle's warranty or details changed after the filed certificate was issued. Reissue it first.",
};
