import { contactName } from "./format";
import { recoverableActiveTenantPredicate } from "./tenantPredicate";

/**
 * WHO A QUOTE IS ADDRESSED TO — the one answer, for every renderer.
 *
 * Nine places printed this block and each computed it itself: the PDF, the print
 * document, the doc-builder merge context, the quotes list, the deliveries board,
 * the invoice, the agreement, the delivery note and the dashboard's stale-quote
 * card. All nine agreed, because all nine were the same two lines copied —
 * `quote.contact ? contactName(quote.contact) : quote.lead?.name`. Adding a third
 * possibility to nine copies is how eight of them get it right.
 *
 * The third possibility is a FLEET. `Quote.fleetId` names a business account, and
 * a quote billed to one is addressed to the BUSINESS — its name, its registration
 * and VAT numbers, its billing address — with the person as "Attention". The
 * contact is not replaced: whoever signs and receives the quote is still
 * `quote.contactId`, which is also what the access checks are keyed on.
 *
 * Precedence is fleet → contact → lead, and it is a precedence rather than a
 * choice: a quote may legitimately carry all three (a fleet account, the manager,
 * and the lead the deal came from), and the most specific billable entity wins.
 *
 * Not "server-only": this is a pure function over rows plus one loader that takes
 * its client as a parameter, so the cross-tenant case is a unit test rather than
 * a hope — the same reasoning as fleetRollup.ts and tenantPredicate.ts. Its
 * callers are server components and route handlers; that is where the boundary
 * belongs. The loader's async tenant predicate dynamically reaches the staff
 * recovery path only when enforcement is on AND the current async frame has lost
 * its scope; ordinary tests with an explicit scope never import that server path.
 */

/** The Fleet columns the printed block uses. Nothing else is read. */
export type BillToFleet = {
  id: string;
  name: string;
  registrationNumber: string | null;
  vatNumber: string | null;
  billingEmail: string | null;
  billingPhone: string | null;
  address: string | null;
  suburb: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
};

export const BILL_TO_FLEET_SELECT = {
  id: true,
  name: true,
  registrationNumber: true,
  vatNumber: true,
  billingEmail: true,
  billingPhone: true,
  address: true,
  suburb: true,
  city: true,
  province: true,
  postalCode: true,
} as const;

type BillToContact = {
  firstName: string;
  lastName?: string | null;
  company?: string | null;
  isCompany?: boolean;
  phone?: string | null;
  email?: string | null;
  vatNumber?: string | null;
  address?: string | null;
  suburb?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
};

type BillToLead = { name: string; phone?: string | null; email?: string | null };

/** A quote, reduced to only what deciding the addressee needs. */
export type BillToQuote = {
  fleetId?: string | null;
  contact?: BillToContact | null;
  lead?: BillToLead | null;
};

export type QuoteBillTo = {
  /** The entity the quote is addressed to. */
  name: string;
  /** The person, when the addressee is a business account. Null otherwise —
   *  printing "Attention: <the same name again>" on an individual's quote is
   *  noise, and on a company contact it is wrong. */
  attention: string | null;
  phone: string;
  email: string;
  address: string;
  vatNumber: string;
  registrationNumber: string;
  /** True when a fleet account resolved. Renderers use it to decide whether the
   *  registration/VAT lines are worth a row at all. */
  isFleet: boolean;
};

const joinAddress = (parts: Array<string | null | undefined>) => parts.filter(Boolean).join(", ");

/**
 * Resolve the addressee.
 *
 * `fleet` is passed in already resolved, not looked up here, so this stays a pure
 * function and so the ONE place a fleet id becomes a fleet row is the tenant-
 * scoped loader below. A caller that has no fleet — or one whose id did not
 * resolve, which is what a cross-tenant id does — passes null and gets exactly
 * the block the app printed before fleets could be billed.
 */
export function quoteBillTo(quote: BillToQuote, fleet: BillToFleet | null): QuoteBillTo {
  const contact = quote.contact ?? null;
  const person = contact ? contactName(contact) : null;

  if (fleet) {
    return {
      name: fleet.name,
      // The person is the ATTENTION line, not the addressee. On a fleet quote
      // this is the whole point: the invoice goes to the lodge, the conversation
      // goes to the manager.
      attention: person,
      // The fleet's BILLING contact details win over the manager's personal ones —
      // that is what those columns are for — but fall back to the person rather
      // than printing a quote with no way to reach anyone.
      phone: fleet.billingPhone ?? contact?.phone ?? quote.lead?.phone ?? "",
      email: fleet.billingEmail ?? contact?.email ?? quote.lead?.email ?? "",
      address: joinAddress([fleet.address, fleet.suburb, fleet.city, fleet.province, fleet.postalCode]),
      // Never the contact's VAT number as a fallback: a fleet member's personal
      // VAT registration is not the account's, and a wrong VAT number on an
      // invoice is a tax document that misstates who may claim the input credit.
      vatNumber: fleet.vatNumber ?? "",
      registrationNumber: fleet.registrationNumber ?? "",
      isFleet: true,
    };
  }

  if (contact) {
    return {
      name: person ?? "",
      attention: null,
      phone: contact.phone ?? quote.lead?.phone ?? "",
      email: contact.email ?? quote.lead?.email ?? "",
      address: joinAddress([contact.address, contact.suburb, contact.city, contact.province, contact.postalCode]),
      vatNumber: contact.vatNumber ?? "",
      registrationNumber: "",
      isFleet: false,
    };
  }

  return {
    name: quote.lead?.name ?? "",
    attention: null,
    phone: quote.lead?.phone ?? "",
    email: quote.lead?.email ?? "",
    address: "",
    vatNumber: "",
    registrationNumber: "",
    isFleet: false,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The one Prisma method this module uses, structurally — same reasoning as
 * fleetRollup.ts's `Finder`: the generated delegate's return type is derived from
 * the `select` it is given, which no hand-written signature can express, so the
 * result is asserted at the one place that `select` is visible.
 */
type FleetFinder = { findMany(args: any): Promise<any[]> };
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Resolve the fleets for a batch of quotes, scoped to the active tenant.
 *
 * THE tenant boundary for this feature. `Quote.fleetId` carries no foreign key —
 * matching Contact.fleetId and Fleet.contactId, and for the same reason — so
 * nothing in the database stops a fleet id from another workspace being written
 * into a quote row. What stops it being READ is this predicate: the id fails to
 * resolve and the quote prints its contact, rather than printing another
 * operator's customer account name, registration number and VAT number onto a
 * document that then goes out to a customer.
 *
 * `db.ts`'s guard extension rewrites nothing while `tenantEnforcing()` is false,
 * so leaning on the client in rollback/dormant mode would be leaning on nothing.
 * The client is a PARAMETER so the two-tenant case is a unit test; the tenant
 * predicate is resolved here and deliberately not accepted from the caller.
 *
 * The predicate is ASYNC because this loader is reached from Server Actions and
 * route handlers as well as Server Components. An enforced request can lose only
 * its AsyncLocalStorage carrier at those boundaries; in that case the shared
 * recoverable predicate revalidates the signed staff session and restores the
 * exact tenant VALUE for this explicit filter. Sessionless or genuinely
 * unresolved callers still fail closed. Existing explicit scopes win unchanged.
 *
 * Batched by design: the quotes list renders 50 rows, and a per-row lookup would
 * be 50 round trips to print 50 names.
 */
export async function loadBillToFleets(
  client: { fleet: FleetFinder },
  fleetIds: Array<string | null | undefined>,
): Promise<Map<string, BillToFleet>> {
  const ids = [...new Set(fleetIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return new Map();
  const tenant = await recoverableActiveTenantPredicate("quote bill-to fleet");
  const rows = (await client.fleet.findMany({
    where: {
      id: { in: ids },
      deletedAt: null,
      ...tenant,
    },
    select: BILL_TO_FLEET_SELECT,
  })) as BillToFleet[];
  return new Map(rows.map((row) => [row.id, row]));
}

/** The single-quote case, in terms of the batch — one implementation, not two. */
export async function loadBillToFleet(
  client: { fleet: FleetFinder },
  fleetId: string | null | undefined,
): Promise<BillToFleet | null> {
  if (!fleetId) return null;
  return (await loadBillToFleets(client, [fleetId])).get(fleetId) ?? null;
}
