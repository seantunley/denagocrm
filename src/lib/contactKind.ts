/**
 * The three-way customer-type selector — individual, business, fleet — expressed
 * in the columns the database ALREADY has.
 *
 * `Contact.isCompany` is a boolean read in a dozen places (the contacts list and
 * detail pages, cases, health scoring, the portal, helpdesk SQL, search SQL,
 * quote rendering), so it was deliberately NOT converted into an enum for this
 * feature: that would have been a rewrite of every one of those readers plus a
 * destructive column change on live data. Instead the third option is expressed
 * by the pair of columns that already carry the meaning:
 *
 *   individual → isCompany = false, fleetId = null
 *   business   → isCompany = true,  fleetId = null
 *   fleet      → isCompany = false, fleetId = <the fleet this contact belongs to>
 *
 * A FLEET CONTACT IS A PERSON, NOT A BUSINESS — that is why `isCompany` stays
 * false for one, and it is the whole point of the feature. `contactName()` reads
 * `isCompany && company` and returns the COMPANY when both are set; the same rule
 * is written out again in the search SQL, the helpdesk SQL and the portal-access
 * SQL. So a fleet member flagged as a company, whose `company` is the fleet's
 * name, would display as the FLEET's name everywhere in the app — and a fleet
 * with five contacts would list the same name five times, which is exactly the
 * thing "a fleet may have more than one contact" exists to make possible.
 *
 * The business ENTITY behind a fleet is the `Fleet` record itself (name,
 * registration number, VAT, billing address) — see prisma/schema.prisma. That is
 * where the company-level facts live, so the contact does not need to pretend to
 * be a company to carry them.
 *
 * Both directions live here, and ONLY here, so the mapping cannot be re-derived
 * slightly differently inside some JSX ternary.
 *
 * Pure: no DB, no server-only imports. `Contact.fleetId` is validated against the
 * caller's own tenant AND their fleet permission where it is READ FROM THE FORM
 * (see app/actions/contacts.ts) — this module never resolves a fleet id and must
 * not be relied on to.
 */

export const CONTACT_KINDS = ["individual", "business", "fleet"] as const;

export type ContactKind = (typeof CONTACT_KINDS)[number];

/** The columns a kind maps onto. Exactly the two the contact form writes. */
export type ContactKindColumns = {
  isCompany: boolean;
  fleetId: string | null;
};

export const CONTACT_KIND_LABELS: Record<ContactKind, string> = {
  individual: "Individual",
  business: "Business",
  fleet: "Fleet",
};

export const CONTACT_KIND_HINTS: Record<ContactKind, string> = {
  individual: "Private customer or driver",
  business: "The business itself is the customer",
  fleet: "A person at a managed fleet account",
};

/**
 * Which selector option an EXISTING contact should show — the derive direction,
 * used when rendering a saved record back into the form.
 *
 * `fleetId` is checked FIRST because it is the more specific fact: it names an
 * actual record. A row carrying both a fleet and the company flag (written by an
 * older build, or by an import) is still a fleet contact.
 */
export function contactKind(contact: {
  isCompany?: boolean | null;
  fleetId?: string | null;
}): ContactKind {
  if (contact.fleetId) return "fleet";
  return contact.isCompany ? "business" : "individual";
}

/**
 * The write direction: the columns to persist for a chosen kind.
 *
 * Choosing anything other than `fleet` CLEARS `fleetId` — switching a contact
 * from a fleet back to an individual must drop the membership, not leave it
 * behind where the fleet page would still list them.
 *
 * `fleet` with no id is representable on purpose (this stays a total function
 * with no throw) and maps to a plain individual. Callers must not let that happen
 * silently: the server action refuses the save and asks for a fleet, so "Fleet"
 * can never be recorded as something else by accident. The round-trip
 * `contactKind(contactKindColumns(kind, id))` therefore holds for every kind
 * EXCEPT that one deliberately-invalid input.
 */
export function contactKindColumns(kind: ContactKind, fleetId: string | null = null): ContactKindColumns {
  if (kind === "business") return { isCompany: true, fleetId: null };
  if (kind === "fleet") return { isCompany: false, fleetId: fleetId || null };
  return { isCompany: false, fleetId: null };
}

/**
 * Does the CONTACT record itself carry the VAT number?
 *
 * Only for `business`, where the contact IS the legal entity a quote is addressed
 * to. A fleet contact is a person: their account's VAT number is captured once on
 * the `Fleet` record and would be a second, drifting copy here. An individual has
 * no VAT number at all.
 */
export function capturesVatNumber(kind: ContactKind): boolean {
  return kind === "business";
}

/** Does this kind REQUIRE a fleet to be chosen before it can be saved? */
export function requiresFleet(kind: ContactKind): boolean {
  return kind === "fleet";
}

/**
 * Read the selector back off a submitted form. Anything unrecognised — a missing
 * field, a forged value — falls back to `individual`, the least privileged shape
 * (no company flag, no fleet link), rather than guessing.
 *
 * Callers must distinguish an INVALID value from an ABSENT field before calling
 * this: a form that never rendered the selector submits nothing, and treating
 * that as "individual" silently strips the fleet off an existing record. See
 * `submittedKind` in app/actions/contacts.ts.
 */
export function parseContactKind(value: unknown): ContactKind {
  return CONTACT_KINDS.includes(value as ContactKind) ? (value as ContactKind) : "individual";
}
