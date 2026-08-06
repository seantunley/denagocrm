import assert from "node:assert/strict";
import { test } from "node:test";

import * as spy from "./stubs/fleetRollupSpy";
import { latestConsentPerMember, loadFleetRollup } from "../src/lib/fleetRollup";
import { withTenant } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { TenantScopeError } from "../src/lib/tenantGuard";

/**
 * BEHAVIOURAL tenant-isolation tests for the fleet record roll-up.
 *
 * The fleet page is the shape that leaks. It gathers a linked contact's
 * activities, leads, communications, research, referrals, documents and consent
 * records — eight cross-entity reads keyed on ids that came from another table —
 * and the `src/lib/db.ts` guard rewrites NOTHING while `tenantEnforcing()` is
 * false, which is the state production runs in. So "the client scopes it" is not
 * true here; every one of those queries has to name the tenant itself.
 *
 * A source-grep for `...tenant` cannot prove that. The predicate can be spread
 * into the wrong object, present on seven queries and missing from the eighth, or
 * shadowed by a later key with the same name. These tests RUN the shipped
 * function against rows belonging to two tenants and assert on what comes back.
 *
 * ── The fixture deliberately collides ids ───────────────────────────────────
 *
 * Both tenants' rows use the SAME fleet id and the SAME contact ids. Real cuids
 * do not collide, and that is exactly why the fixture must: id unguessability is
 * not an access control, and the isolation contract is that the TENANT PREDICATE
 * keeps tenants apart. Colliding the ids removes the accidental protection and
 * leaves only the thing under test. It is also the literal state after the
 * enforcement flip, and the shape a guessed URL or a forged form value produces.
 *
 * If any query in loadFleetRollup drops its predicate, the other tenant's rows
 * come straight back and these fail. The stub applies no scoping of its own —
 * see tests/stubs/fleetRollupSpy.ts.
 */

const FLEET = "flt_shared";
/** Ids reused across BOTH tenants — see the note above. */
const ALICE = "c_alice";
const BOB = "c_bob";

const MINE = "tenant_mine";
const THEIRS = "tenant_theirs";

const day = (n: number) => new Date(Date.UTC(2026, 0, n));

function contactRow(id: string, firstName: string, tenantId: string): spy.Row {
  return {
    id,
    tenantId,
    fleetId: FLEET,
    deletedAt: null,
    firstName,
    lastName: tenantId === MINE ? "Mine" : "Theirs",
    company: "Shared Lodge",
    isCompany: false,
    email: `${firstName.toLowerCase()}@example.com`,
    phone: "0800",
    owner: { name: "Owner" },
  };
}

/**
 * One row per rolled-up model, all belonging to `contactId`, all in `tenantId`.
 *
 * Seeded for BOTH tenants against the SAME contact id, so every collection has a
 * foreign row sitting right next to the legitimate one.
 */
function recordsFor(contactId: string, tenantId: string, tag: string) {
  const mine = tenantId === MINE;
  return {
    activity: {
      id: `act_${tag}`,
      tenantId,
      contactId,
      type: "call",
      category: null,
      summary: mine ? "Ours" : "THEIRS",
      note: null,
      location: null,
      dueDate: day(2),
      status: "planned",
      assignedTo: { id: "u1", name: "Staff" },
    },
    lead: {
      id: `lead_${tag}`,
      tenantId,
      contactId,
      deletedAt: null,
      title: mine ? "Ours" : "THEIRS",
      valueCents: 1000,
      status: "open",
      stage: { name: "New" },
      createdAt: day(2),
    },
    communication: {
      id: `comm_${tag}`,
      tenantId,
      contactId,
      type: "email",
      direction: "out",
      subject: mine ? "Ours" : "THEIRS",
      body: "body",
      attachmentUrl: null,
      occurredAt: day(2),
      user: { name: "Staff" },
    },
    researchNote: {
      id: `note_${tag}`,
      tenantId,
      contactId,
      body: mine ? "Ours" : "THEIRS",
      createdAt: day(2),
    },
    referral: {
      id: `ref_${tag}`,
      tenantId,
      // Keyed on the MEMBER as referrer — the fleet gets credit for referrals its
      // people MADE. `contactId` here is whoever was referred IN.
      referrerId: contactId,
      contactId: "someone_else",
      status: "earned",
      redeemedNote: null,
      createdAt: day(2),
      lead: null,
      contact: null,
    },
    document: {
      id: `doc_${tag}`,
      tenantId,
      contactId,
      deletedAt: null,
      fileName: mine ? "ours.pdf" : "THEIRS.pdf",
      sizeBytes: 10,
      createdAt: day(2),
      tag: null,
      uploadedBy: { name: "Staff" },
    },
    consentRecord: {
      id: `con_${tag}`,
      tenantId,
      contactId,
      type: "marketing",
      granted: true,
      source: "web",
      createdAt: day(2),
    },
    // A quote filed against the MEMBER — the roll-up arm. The account-billed arm
    // (`fleetId` set, no member) is seeded separately, because it is the one that
    // has to survive a fleet with no members at all.
    quote: {
      id: `quote_${tag}`,
      tenantId,
      contactId,
      fleetId: null,
      deletedAt: null,
      number: 1,
      status: mine ? "draft" : "THEIRS",
      createdAt: day(2),
      signedAt: null,
      items: [],
      fees: [],
    },
  };
}

/** A quote billed to the fleet ACCOUNT rather than to any one member. */
function accountQuote(tenantId: string, tag: string): spy.Row {
  return {
    id: `acctquote_${tag}`,
    tenantId,
    contactId: null,
    fleetId: FLEET,
    deletedAt: null,
    number: 900,
    status: tenantId === MINE ? "sent" : "THEIRS",
    createdAt: day(1),
    signedAt: null,
    items: [],
    fees: [],
  };
}

/**
 * Both tenants, fully populated, every id colliding.
 *
 * The return type is stated rather than inferred so a test can trash a row
 * (`deletedAt = day(3)`); inferred, `deletedAt` narrows to the literal `null`.
 */
function twoTenantFixture(): Record<spy.ModelName, spy.Row[]> {
  const mineAlice = recordsFor(ALICE, MINE, "mine_alice");
  const mineBob = recordsFor(BOB, MINE, "mine_bob");
  const theirsAlice = recordsFor(ALICE, THEIRS, "theirs_alice");

  return {
    contact: [
      contactRow(ALICE, "Alice", MINE),
      contactRow(BOB, "Bob", MINE),
      // Same fleet id, same contact id, different tenant.
      contactRow(ALICE, "Mallory", THEIRS),
    ],
    activity: [mineAlice.activity, mineBob.activity, theirsAlice.activity],
    lead: [mineAlice.lead, mineBob.lead, theirsAlice.lead],
    communication: [mineAlice.communication, mineBob.communication, theirsAlice.communication],
    researchNote: [mineAlice.researchNote, mineBob.researchNote, theirsAlice.researchNote],
    referral: [mineAlice.referral, mineBob.referral, theirsAlice.referral],
    document: [mineAlice.document, mineBob.document, theirsAlice.document],
    consentRecord: [
      mineAlice.consentRecord,
      mineBob.consentRecord,
      theirsAlice.consentRecord,
    ],
    quote: [
      mineAlice.quote,
      mineBob.quote,
      theirsAlice.quote,
      // Same fleet id in BOTH tenants, billed to the account in both. This is the
      // pair that matters: Quote.fleetId carries no foreign key, so nothing in
      // the database stops a fleet id from colliding across workspaces.
      accountQuote(MINE, "mine"),
      accountQuote(THEIRS, "theirs"),
    ],
  };
}

const rollupInTenant = (tenantId: string, includeReferrals = true) =>
  withTenant(tenantId, () => loadFleetRollup(spy.prisma, FLEET, { includeReferrals }));

// ── the isolation test ──────────────────────────────────────────────────────

test("no other tenant's record reaches a fleet page — members", async () => {
  spy.reset(twoTenantFixture());
  const rollup = await rollupInTenant(MINE);

  assert.deepEqual(
    rollup.members.map((member) => member.firstName),
    ["Alice", "Bob"],
    "membership must be the active tenant's contacts only — Mallory belongs to another workspace",
  );
  assert.ok(
    !rollup.members.some((member) => member.lastName === "Theirs"),
    "another tenant's contact appeared in the fleet's membership",
  );
});

test("no other tenant's record reaches a fleet page — every rolled-up tab", async () => {
  // The membership query is the load-bearing one, but an id list is not an
  // authorization: each follow-up query states the tenant itself, so a member id
  // that leaked in from anywhere cannot pull a foreign workspace's history onto
  // the page. This asserts that per tab rather than in aggregate, so a single
  // unscoped query is named rather than hidden in a total.
  spy.reset(twoTenantFixture());
  const rollup = await rollupInTenant(MINE);

  const collections: [string, { id: string }[]][] = [
    ["activities", rollup.activities],
    ["leads", rollup.leads],
    ["communications", rollup.communications],
    ["researchNotes", rollup.researchNotes],
    ["referrals", rollup.referrals],
    ["documents", rollup.documents],
    ["consentRecords", rollup.consentRecords],
  ];

  for (const [name, rows] of collections) {
    assert.equal(rows.length, 2, `${name}: expected one row per member of THIS tenant`);
    const foreign = rows.filter((row) => row.id.includes("theirs"));
    assert.deepEqual(
      foreign,
      [],
      `${name}: another tenant's rows are on this fleet page — ${foreign.map((r) => r.id).join(", ")}`,
    );
  }
});

test("every roll-up query names the tenant it was asked for", async () => {
  // The complement of the assertions above: not just "the wrong rows did not come
  // back" but "the filter that excluded them was the tenant". Reading the `where`
  // of each call catches a query that happens to be correct here only because the
  // fixture is small.
  spy.reset(twoTenantFixture());
  await rollupInTenant(MINE);

  for (const model of spy.MODELS) {
    const seen = spy.wheres(model);
    assert.ok(seen.length > 0, `${model} was never queried`);
    for (const where of seen) {
      assert.equal(
        where.tenantId,
        MINE,
        `${model} was queried without the active tenant: ${JSON.stringify(where)}`,
      );
    }
  }
});

test("the same fleet id renders a different fleet for a different tenant", async () => {
  // The same URL, two workspaces, no overlap in either direction.
  spy.reset(twoTenantFixture());
  const theirs = await rollupInTenant(THEIRS);

  assert.deepEqual(theirs.members.map((member) => member.firstName), ["Mallory"]);
  assert.deepEqual(theirs.documents.map((document) => document.fileName), ["THEIRS.pdf"]);
});

test("under enforcement, a scopeless roll-up refuses rather than reading every tenant", async () => {
  // The owner escape hatch: under enforcement a global owner may continue with NO
  // resolved tenant so the platform console works. A page that treated that as
  // "no filter" would hand them every workspace's customers, messages and
  // documents in one view.
  spy.reset(twoTenantFixture());
  try {
    __setTenantEnforcingForTests(true);
    await assert.rejects(
      () => loadFleetRollup(spy.prisma, FLEET, { includeReferrals: true }),
      TenantScopeError,
    );
    assert.deepEqual(spy.calls, [], "nothing may be read before the scope is checked");
  } finally {
    __setTenantEnforcingForTests(null);
  }
});

// ── the module switch is a switch, not a filter ─────────────────────────────

test("with marketing off the referral query never runs at all", async () => {
  spy.reset(twoTenantFixture());
  const rollup = await rollupInTenant(MINE, false);

  assert.deepEqual(rollup.referrals, []);
  assert.deepEqual(
    spy.wheres("referral"),
    [],
    "a disabled module must not read the data and hide it — that is still a read",
  );
});

test("referrals follow the member as REFERRER, not as the person referred in", async () => {
  // Keying on `contactId` would list referrals the fleet RECEIVED from strangers
  // and credit them to the fleet. The seeded rows have contactId "someone_else"
  // precisely so a contactId-keyed query returns nothing.
  spy.reset(twoTenantFixture());
  const rollup = await rollupInTenant(MINE);

  assert.deepEqual(rollup.referrals.map((referral) => referral.referrerId).sort(), [ALICE, BOB]);
  for (const where of spy.wheres("referral")) {
    assert.ok(where.referrerId, "referrals must be keyed on referrerId");
    assert.equal(where.contactId, undefined, "…and never on contactId");
  }
});

// ── the empty and deleted cases ─────────────────────────────────────────────

test("a fleet with no members runs no member-keyed queries — but still reads its quotes", async () => {
  spy.reset(twoTenantFixture());
  const rollup = await withTenant(MINE, () =>
    loadFleetRollup(spy.prisma, "flt_nobody", { includeReferrals: true }),
  );

  assert.deepEqual(rollup.members, []);
  assert.deepEqual(rollup.memberIds, []);
  assert.deepEqual(rollup.activities, []);
  assert.deepEqual(
    spy.calls.map((call) => call.model),
    ["contact", "quote"],
    "`{ in: [] }` is seven guaranteed-empty round trips, some of them expensive — " +
      "but quotes are keyed on Quote.fleetId as well as on members, so that one must still run",
  );
});

test("a quote billed to the account appears before anyone is linked to it", async () => {
  // The reason the quotes query sits ahead of the no-members early return. A
  // fleet can be quoted the day it is created; filing that query under the
  // members-only branch would have made the first quote you raise for a new
  // account invisible on the account's own page.
  spy.reset(twoTenantFixture());
  const rollup = await withTenant(MINE, () =>
    loadFleetRollup(spy.prisma, FLEET, { includeReferrals: true }),
  );
  const ids = rollup.quotes.map((quote) => quote.id);
  assert.ok(ids.includes("acctquote_mine"), "a quote billed to this fleet belongs on its page");
  assert.ok(ids.includes("quote_mine_alice"), "…and so does a member's own quote");
});

test("no other tenant's quote reaches a fleet page, even on a colliding fleet id", async () => {
  // Quote.fleetId carries no foreign key by design, so the tenant predicate is
  // the ONLY thing standing between a colliding id and another operator's quote
  // appearing on this account's page — with its number, status and total.
  spy.reset(twoTenantFixture());
  const rollup = await withTenant(MINE, () =>
    loadFleetRollup(spy.prisma, FLEET, { includeReferrals: true }),
  );
  for (const quote of rollup.quotes) {
    assert.notEqual(quote.status, "THEIRS", `quote ${quote.id} came from the other tenant`);
  }
  assert.ok(
    spy.wheres("quote").every((where) => where.tenantId === MINE),
    "the quote query must name the tenant, not filter afterwards",
  );
});

test("trashed members, leads and documents stay off the fleet page", async () => {
  // Soft delete is the house convention (60-day trash), and a roll-up that
  // ignores it resurrects deleted records on a page nobody thinks to check.
  const fixture = twoTenantFixture();
  fixture.contact[1].deletedAt = day(3); // Bob is in the trash
  fixture.lead[0].deletedAt = day(3);
  fixture.document[0].deletedAt = day(3);
  spy.reset(fixture);

  const rollup = await rollupInTenant(MINE);

  assert.deepEqual(rollup.members.map((member) => member.firstName), ["Alice"]);
  assert.deepEqual(rollup.leads, [], "Alice's only lead is trashed");
  assert.deepEqual(rollup.documents, [], "Alice's only document is trashed");
});

// ── consent is a log, and the page shows a position ─────────────────────────

test("the latest consent decision per member per type wins", async () => {
  // THE ONE THAT MATTERS FOR POPIA. Consent is append-only: a "withdrawn" row
  // after a "granted" row is the CURRENT answer, and a page listing both shows a
  // customer as consenting when they have opted out. Rows arrive newest-first.
  const withdrawn = {
    id: "con_new",
    contactId: ALICE,
    type: "marketing",
    granted: false,
    source: "email",
    createdAt: day(9),
  };
  const granted = {
    id: "con_old",
    contactId: ALICE,
    type: "marketing",
    granted: true,
    source: "web",
    createdAt: day(1),
  };
  const otherType = {
    id: "con_sms",
    contactId: ALICE,
    type: "sms",
    granted: true,
    source: "web",
    createdAt: day(5),
  };
  const otherMember = {
    id: "con_bob",
    contactId: BOB,
    type: "marketing",
    granted: true,
    source: "web",
    createdAt: day(5),
  };

  const latest = latestConsentPerMember([withdrawn, otherType, otherMember, granted]);

  assert.deepEqual(latest.map((record) => record.id), ["con_new", "con_sms", "con_bob"]);
  assert.equal(
    latest.find((record) => record.contactId === ALICE && record.type === "marketing")?.granted,
    false,
    "a withdrawal must not be masked by an older grant",
  );
});
