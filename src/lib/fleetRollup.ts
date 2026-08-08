/**
 * Everything a fleet's record tabs show, gathered from the contacts linked to it.
 *
 * A fleet owns almost none of these rows. Its activities, leads, communications,
 * research, referrals, documents and consent records are the UNION of its
 * members' — "if a contact is linked, all the details from those contacts show up
 * in here". So the fleet page needs the same eight queries the contact page runs,
 * against a SET of contacts rather than one.
 *
 * ── Why this is a module and not eight queries in the page ──────────────────
 *
 * Every one of those queries is a cross-entity read keyed on ids that came from
 * ANOTHER table, which is the exact shape that leaks across tenants. The guard
 * extension in db.ts scopes nothing unless `tenantEnforcing()` is true, and it is
 * false in production today, so "the client will scope it" is not true here — the
 * predicate has to be written out. Written out eight times in a page, seven of
 * them are right and the eighth is the incident. Written once, here, the fleet
 * page cannot get it wrong and cannot drift when a ninth tab is added.
 *
 * The membership query is the load-bearing one: it resolves WHICH contacts are in
 * the fleet, and every other query is keyed on its result. Scope that one and the
 * seven that follow inherit the scope — but they still state it themselves,
 * because an id list is not an authorization and a member id that leaked in from
 * anywhere would otherwise pull that tenant's whole history onto the page.
 *
 * ── Why the client is a parameter ───────────────────────────────────────────
 *
 * So the cross-tenant case can actually be TESTED. Reaching for `prisma` directly
 * would make the only interesting question — does a second tenant's data appear
 * on this page — answerable solely by a live two-tenant database with RLS, which
 * the unit suite does not have. With the client injected, tests/fleetRollup.test
 * runs this function against a two-tenant fixture and asserts the queries this
 * code actually builds exclude the other tenant. Callers pass the normal filtered
 * `prisma`; the tenant predicate is resolved HERE, from the ambient scope, and is
 * deliberately NOT a parameter — a caller that can pass the tenant is a caller
 * that can pass the wrong one.
 *
 * Not marked "server-only" for the same reason tenantPredicate.ts is not: doing
 * so would make the case that reopens cross-tenant reads untestable. Its one
 * caller is a server component; that is where the boundary belongs.
 */

import { activeTenantPredicate } from "./tenantPredicate";

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The one Prisma method this module uses, structurally.
 *
 * BOTH the argument and the row are `any`, and that is not laziness. Prisma's
 * generated delegates are generic and overloaded: `contact.findMany` declares a
 * return type derived from the `select` it is GIVEN, which no hand-written
 * signature can express. Declaring `findMany(args: any): Promise<FleetMember[]>`
 * therefore does not describe the real client — it REJECTS it, because
 * `Promise<Contact[]>` is not assignable to `Promise<FleetMember[]>`. That is the
 * error this module shipped with.
 *
 * The types are not lost, only moved: each result is asserted to its concrete row
 * type at the one place the `select` that produces it is visible — right beside
 * the query — so `FleetRollup` and everything downstream of it stay fully typed.
 */
type Finder = { findMany(args: any): Promise<any[]> };
/* eslint-enable @typescript-eslint/no-explicit-any */

export type FleetMember = {
  id: string;
  firstName: string;
  lastName: string | null;
  company: string | null;
  isCompany: boolean;
  email: string | null;
  phone: string | null;
  owner: { name: string } | null;
};

export type FleetActivity = {
  id: string;
  contactId: string | null;
  type: string;
  category: string | null;
  summary: string;
  note: string | null;
  location: string | null;
  dueDate: Date;
  status: string;
  assignedTo: { id: string; name: string };
};

export type FleetLead = {
  id: string;
  contactId: string | null;
  title: string;
  valueCents: number;
  status: string;
  stage: { name: string };
};

export type FleetCommunication = {
  id: string;
  contactId: string | null;
  type: string;
  direction: string | null;
  subject: string | null;
  body: string;
  attachmentUrl: string | null;
  occurredAt: Date;
  user: { name: string };
};

export type FleetResearchNote = {
  id: string;
  contactId: string | null;
  body: string;
  createdAt: Date;
};

export type FleetReferral = {
  id: string;
  referrerId: string;
  status: string;
  redeemedNote: string | null;
  createdAt: Date;
  lead: { id: string; name: string } | null;
  contact: { id: string; firstName: string; lastName: string | null; company: string | null; isCompany: boolean } | null;
};

export type FleetDocument = {
  id: string;
  contactId: string | null;
  fileName: string;
  sizeBytes: number;
  createdAt: Date;
  tag: string | null;
  uploadedBy: { name: string };
};

export type FleetConsentRecord = {
  id: string;
  contactId: string;
  type: string;
  granted: boolean;
  source: string | null;
  createdAt: Date;
};

export type FleetRollupClient = {
  contact: Finder;
  activity: Finder;
  lead: Finder;
  communication: Finder;
  researchNote: Finder;
  referral: Finder;
  document: Finder;
  consentRecord: Finder;
};

export type FleetRollup = {
  members: FleetMember[];
  memberIds: string[];
  activities: FleetActivity[];
  leads: FleetLead[];
  communications: FleetCommunication[];
  researchNotes: FleetResearchNote[];
  referrals: FleetReferral[];
  documents: FleetDocument[];
  consentRecords: FleetConsentRecord[];
};

const EMPTY: Omit<FleetRollup, "members" | "memberIds"> = {
  activities: [],
  leads: [],
  communications: [],
  researchNotes: [],
  referrals: [],
  documents: [],
  consentRecords: [],
};

/**
 * A page of rows is a page, not a whole history. Every aggregate tab is a
 * newest-first list a person reads, and a fleet with two hundred members would
 * otherwise pull its entire customer history into one render.
 */
const PAGE = 200;

/** Members shown on the Contacts tab. Higher than PAGE: this list IS the fleet. */
const MEMBER_LIMIT = 500;

/**
 * Load every linked contact's records for one fleet.
 *
 * `includeReferrals` is the marketing module switch, passed in because module
 * state is resolved by the page (which already awaits it for its other tabs) and
 * because "off" must mean the query never runs, not that its result is hidden.
 */
export async function loadFleetRollup(
  client: FleetRollupClient,
  fleetId: string,
  { includeReferrals }: { includeReferrals: boolean },
): Promise<FleetRollup> {
  // Resolved ONCE and spread into all eight queries. Under enforcement this is
  // the active tenant and the db.ts guard re-applies the identical value; with
  // enforcement off it is `{}` — which is correct, because "no scope" means
  // nobody ever told this request which tenant it is, and inventing
  // `tenantId: null` there would filter on the legacy untenanted value and hide
  // every migrated row. See tenantPredicate.ts.
  const tenant = activeTenantPredicate("fleet record roll-up");

  const members = (await client.contact.findMany({
    // Membership is `Contact.fleetId` — the MANY side. `Fleet.contactId` names
    // the one primary contact / manager and is a different fact; a fleet's
    // manager is normally also a member, but the two are not interchangeable.
    where: { fleetId, deletedAt: null, ...tenant },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      company: true,
      isCompany: true,
      email: true,
      phone: true,
      owner: { select: { name: true } },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    take: MEMBER_LIMIT,
  })) as FleetMember[];

  const memberIds = members.map((member) => member.id);
  // Nothing to union. `{ in: [] }` is seven guaranteed-empty round trips, and
  // some of them are the expensive ones.
  if (memberIds.length === 0) return { members, memberIds, ...EMPTY };

  const scopedToMembers = { contactId: { in: memberIds }, ...tenant };

  // The concrete row types are asserted HERE, on the tuple, because this is where
  // the `select` for each query is in view — see the note on `Finder` above for
  // why the client type itself cannot carry them.
  const [activities, leads, communications, researchNotes, referrals, documents, consentRecords] =
    (await Promise.all([
      client.activity.findMany({
        where: scopedToMembers,
        select: {
          id: true,
          contactId: true,
          type: true,
          category: true,
          summary: true,
          note: true,
          location: true,
          dueDate: true,
          status: true,
          assignedTo: { select: { id: true, name: true } },
        },
        orderBy: { dueDate: "asc" },
        take: PAGE,
      }),
      client.lead.findMany({
        where: { ...scopedToMembers, deletedAt: null },
        select: {
          id: true,
          contactId: true,
          title: true,
          valueCents: true,
          status: true,
          stage: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: PAGE,
      }),
      client.communication.findMany({
        where: scopedToMembers,
        select: {
          id: true,
          contactId: true,
          type: true,
          direction: true,
          subject: true,
          body: true,
          attachmentUrl: true,
          occurredAt: true,
          user: { select: { name: true } },
        },
        orderBy: { occurredAt: "desc" },
        take: PAGE,
      }),
      client.researchNote.findMany({
        where: scopedToMembers,
        select: { id: true, contactId: true, body: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: PAGE,
      }),
      // Referrals hang off `referrerId`, not `contactId` — a member's OWN
      // referrals are the ones the fleet gets credit for. `contactId` on this
      // model is the person who was referred IN, so keying on it would list
      // referrals the fleet received from strangers.
      includeReferrals
        ? client.referral.findMany({
            where: { referrerId: { in: memberIds }, ...tenant },
            select: {
              id: true,
              referrerId: true,
              status: true,
              redeemedNote: true,
              createdAt: true,
              lead: { select: { id: true, name: true } },
              contact: {
                select: { id: true, firstName: true, lastName: true, company: true, isCompany: true },
              },
            },
            orderBy: { createdAt: "desc" },
            take: PAGE,
          })
        : Promise.resolve([]),
      // The members' own filed paperwork. Quote documents are deliberately not
      // pulled in: quoting a fleet does not exist yet (there is no
      // `Quote.fleetId`), so a quote here would be a member's personal quote
      // shown under the account's name.
      client.document.findMany({
        where: { ...scopedToMembers, deletedAt: null },
        select: {
          id: true,
          contactId: true,
          fileName: true,
          sizeBytes: true,
          createdAt: true,
          tag: true,
          uploadedBy: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: PAGE,
      }),
      client.consentRecord.findMany({
        where: scopedToMembers,
        select: { id: true, contactId: true, type: true, granted: true, source: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: PAGE,
      }),
    ])) as [
      FleetActivity[],
      FleetLead[],
      FleetCommunication[],
      FleetResearchNote[],
      FleetReferral[],
      FleetDocument[],
      FleetConsentRecord[],
    ];

  return {
    members,
    memberIds,
    activities,
    leads,
    communications,
    researchNotes,
    referrals,
    documents,
    consentRecords,
  };
}

/**
 * The latest consent decision per type, per member — what the Privacy tab shows.
 *
 * Consent is an append-only log: a "withdrawn" row after a "granted" row for the
 * same type is the CURRENT answer, and a fleet page listing both would show a
 * customer as consenting when they have opted out. Rows arrive newest-first, so
 * the first one seen for a (contact, type) pair wins.
 */
export function latestConsentPerMember(records: FleetConsentRecord[]): FleetConsentRecord[] {
  const seen = new Set<string>();
  const latest: FleetConsentRecord[] = [];
  for (const record of records) {
    const key = `${record.contactId}:${record.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push(record);
  }
  return latest;
}
