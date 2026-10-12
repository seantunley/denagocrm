import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import Module, { createRequire } from "node:module";

/*
 * The lead score, run for real against a fake database that applies the same
 * where-filters Prisma would. Pins the #776 review: a note — even one filed as
 * "inbound" — is never "the customer wrote to us", and never "last contact".
 */

type Comm = { leadId: string | null; contactId?: string | null; type: string; direction: string | null; occurredAt: Date };
type Act = { leadId: string | null; contactId?: string | null; type: string; status: string; availabilityBlock: boolean; doneAt: Date | null; dueDate: Date };
type Where = Record<string, unknown>;

/** `links`: which customer each lead belongs to (Lead.contactId). */
const state = { comms: [] as Comm[], acts: [] as Act[], links: [] as { id: string; contactId: string | null }[] };
const day = (n: number) => new Date(Date.UTC(2026, 9, n, 9));

function passes(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; notIn?: unknown[]; not?: unknown };
      if (c.in) return c.in.includes(value);
      if (c.notIn) return !c.notIn.includes(value);
      if ("not" in c) return value !== c.not;
    }
    return value === cond;
  });
}

function groupBy<T extends { leadId: string | null; contactId?: string | null }>(rows: T[], args: { by?: string[]; where: Where; _max?: Record<string, true>; _min?: Record<string, true> }) {
  const field = Object.keys(args._max ?? args._min ?? {})[0] as keyof T;
  const key = (args.by?.[0] ?? "leadId") as "leadId" | "contactId";
  const pickMax = Boolean(args._max);
  const out = new Map<string, Date | null>();
  // A missing column reads as null, as it does in the database.
  for (const row of rows.filter((r) => passes({ contactId: null, ...r } as Record<string, unknown>, args.where))) {
    const group = row[key];
    if (!group) continue;
    const v = row[field] as unknown as Date | null;
    const cur = out.get(group) ?? null;
    if (v && (!cur || (pickMax ? v > cur : v < cur))) out.set(group, v);
  }
  return [...out].map(([group, v]) => ({ [key]: group, [pickMax ? "_max" : "_min"]: { [field]: v } }));
}

const fakePrisma = {
  lead: { findMany: async (args: { where: Where }) => state.links.filter((link) => passes(link as Record<string, unknown>, args.where)) },
  communication: { groupBy: async (args: { by?: string[]; where: Where; _max: Record<string, true> }) => groupBy(state.comms, args) },
  activity: { groupBy: async (args: { by?: string[]; where: Where; _max?: Record<string, true>; _min?: Record<string, true> }) => groupBy(state.acts, args) },
  quote: { groupBy: async () => [] },
};

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if ((parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/leadScoreLoader.ts")) {
    if (request === "./db") return { prisma: fakePrisma };
    if (request === "./permissions") return { getAccessibleLeadIds: async () => null };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const { scoreLeads } = require_("../src/lib/leadScoreLoader.ts") as typeof import("../src/lib/leadScoreLoader");

const LEAD = { id: "lead1", valueCents: 25_000_000, status: "open", createdAt: day(1), stageEnteredAt: day(1), stage: { name: "Quoted", isClosed: false, staleAfterDays: null } };
const score = async () => (await scoreLeads([LEAD], day(11))).get("lead1")!;
const waiting = (s: { reasons: string[] }) => s.reasons.some((r) => /waiting on our reply/.test(r));

beforeEach(() => {
  state.comms = [];
  state.acts = [];
  state.links = [];
});

const uncontacted = (s: { reasons: string[] }) => s.reasons.some((r) => /not contacted yet|Never contacted/.test(r));

test("AN EMAIL FILED ON THE CUSTOMER, WITH NO LEAD, IS CONTACT: the lead no longer says 'not contacted yet'", async () => {
  // Sean, 2026-10-12: a lead on Today read "New lead — not contacted yet" with
  // an email to that customer sent the same morning. The email was written from
  // the customer's page, so it carried the customer and no lead.
  state.links = [{ id: "lead1", contactId: "cust1" }];
  assert.ok(uncontacted(await score()), "nothing at all yet");
  state.comms = [{ leadId: null, contactId: "cust1", type: "email", direction: "outbound", occurredAt: day(10) }];
  assert.equal(uncontacted(await score()), false, "the customer was emailed");
  // And the customer's own lead-less message (an inbox reply, Messenger) is "waiting on our reply".
  state.comms = [{ leadId: null, contactId: "cust1", type: "email", direction: "inbound", occurredAt: day(10) }];
  assert.ok(waiting(await score()));
  // A finished call or meeting booked on the customer counts the same way.
  state.comms = [];
  state.acts = [{ leadId: null, contactId: "cust1", type: "call", status: "done", availabilityBlock: false, doneAt: day(10), dueDate: day(10) }];
  assert.equal(uncontacted(await score()), false);
});

test("…but not another customer's, not the customer's rows on ANOTHER lead, and never a note", async () => {
  state.links = [{ id: "lead1", contactId: "cust1" }];
  state.comms = [
    { leadId: null, contactId: "cust2", type: "email", direction: "outbound", occurredAt: day(10) }, // somebody else
    { leadId: "lead2", contactId: "cust1", type: "email", direction: "outbound", occurredAt: day(10) }, // this customer's other deal
    { leadId: null, contactId: "cust1", type: "note", direction: "outbound", occurredAt: day(10) }, // written for ourselves
  ];
  assert.ok(uncontacted(await score()));
  // A lead with no customer attached reads only its own rows, as before.
  state.links = [{ id: "lead1", contactId: null }];
  state.comms = [{ leadId: null, contactId: null, type: "email", direction: "outbound", occurredAt: day(10) }];
  assert.ok(uncontacted(await score()));
});

test("a real inbound message we haven't answered IS 'waiting on our reply'", async () => {
  state.comms = [{ leadId: "lead1", type: "whatsapp", direction: "inbound", occurredAt: day(9) }];
  assert.ok(waiting(await score()));
});

test("a NEWER note filed as inbound never makes the lead look like the customer wrote", async () => {
  state.comms = [
    { leadId: "lead1", type: "whatsapp", direction: "inbound", occurredAt: day(2) }, // the customer wrote
    { leadId: "lead1", type: "call", direction: "outbound", occurredAt: day(5) }, // we answered
    { leadId: "lead1", type: "note", direction: "inbound", occurredAt: day(10) }, // a staff note, filed as inbound
  ];
  assert.equal(waiting(await score()), false, "answered on the 5th — the note on the 10th is not a reply from them");
});

test("a note never counts as last contact either — in or out", async () => {
  state.comms = [
    { leadId: "lead1", type: "whatsapp", direction: "inbound", occurredAt: day(2) },
    { leadId: "lead1", type: "note", direction: "outbound", occurredAt: day(10) },
  ];
  // The customer's message on the 2nd is still the latest real touch: waiting on us.
  assert.ok(waiting(await score()), "a note on our side is not answering them");
  state.acts = [{ leadId: "lead1", type: "todo", status: "done", availabilityBlock: false, doneAt: day(10), dueDate: day(10) }];
  assert.ok(waiting(await score()), "nor is ticking off a to-do");
});
