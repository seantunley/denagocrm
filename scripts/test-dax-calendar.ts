/**
 * DAX'S CALENDAR ITEMS AND TEST DRIVES, ON A REAL DATABASE (Sean, 2026-10-29).
 *
 *   "DAX requires a lead or contact to add a calendar item, that needs to change." Asked for a meeting with Mariska —
 *   a prospect, no surname, not in the CRM — DAX found the slot, then said "the meeting card needs a lead to attach
 *   to". And: "when booking a test drive, DAX requires a demo vehicle from stock. That is not needed."
 *
 * Real cards from resolveActions and the real Confirm (runAssistantAction), as a signed-in member of each of two
 * workspaces (scripts/harness/actAs.ts), enforcement off then on — every verdict read back from the rows written:
 *  - a to-do and a meeting on NOBODY land on the person's own calendar, in their workspace, with the colleague invited;
 *  - a follow-up on a customer with no deal is on that customer;
 *  - another workspace's customer is never a card, and a forged card naming one books nothing;
 *  - a test drive with no demo vehicle is booked, on the deal or on the customer directly, where they said — and, said
 *    nowhere, where they last booked one; with neither, DAX asks.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes what it creates.
 */
import { basePrisma } from "../src/lib/db";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { resolveActions } from "../src/lib/crmAssistant";
import { runAssistantAction } from "../src/app/actions/assistant";
import type { ActionCard, ProposedAction } from "../src/lib/assistantActions";
import type { PermissionUser } from "../src/lib/permissions";
import { seedTwoTenants, teardown } from "./harness/seed";
import { actAsStaff } from "./harness/actAs";

const SFX = Math.random().toString(16).slice(2, 10);
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
  }
}

/** A South African local time some days ahead, as the cards take it ("YYYY-MM-DDTHH:MM"). */
const ahead = (days: number, hour: number, minute = 0) => {
  const date = new Date(Date.now() + 2 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`cal${SFX}`);
  const { a, b } = fixture;
  // DAX is the Automation & AI module's: granted, or Confirm refuses before it books anything.
  await basePrisma.$executeRaw`UPDATE "Tenant" SET "modules" = "modules" || ',automation' WHERE "id" IN (${a.tenantId}, ${b.tenantId})`;
  // The fixture's own test drive is the member's, stamped by the database's clock — local time on a developer's
  // embedded PostgreSQL, two hours "later" than the UTC the app writes. Long ago, so "where they last booked one"
  // is decided by the bookings made here.
  await basePrisma.$executeRaw`UPDATE "TestDriveBooking" SET "createdAt" = '2025-01-01T00:00:00Z' WHERE "id" = ${a.rows.testDriveId}`;
  const person = async (id: string): Promise<PermissionUser> => {
    const row = await basePrisma.user.findUniqueOrThrow({ where: { id }, select: { id: true, name: true, email: true, role: true } });
    return { id: row.id, name: row.name, email: row.email, role: row.role };
  };
  const memberA = await person(a.memberUserId);
  const ownerA = await person(a.ownerUserId);
  const contactA = await basePrisma.contact.findUniqueOrThrow({ where: { id: a.rows.contactId }, select: { firstName: true, lastName: true } });
  const nameA = [contactA.firstName, contactA.lastName].filter(Boolean).join(" ");

  try {
    let day = 3;
    for (const enforcing of [false, true]) {
      __setTenantEnforcingForTests(enforcing);
      console.log(`\nCalendar items and test drives from DAX — tenant enforcement ${enforcing ? "ON" : "off"}`);
      const asA = <T>(work: () => Promise<T>) => actAsStaff(a, work, { enforcing });
      const cardsFor = (actions: ProposedAction[], problems: string[] = []) => asA(() => resolveActions(memberA, actions, problems));
      const confirm = (card: ActionCard) => asA(() => runAssistantAction(card));
      const mode = enforcing ? "on" : "off";
      day += 1;

      // ── a to-do on nobody: the person's own calendar ─────────────────────
      const todo = `Order stock ${SFX} ${mode}`;
      const [todoCard] = await cardsFor([{ type: "follow_up", when: ahead(day, 9), activity: "todo", summary: todo }]);
      check("a to-do on nobody is a card — no lead, no customer, on 'Your calendar'", todoCard?.kind === "follow_up" && todoCard.leadId === null && !("contactId" in todoCard && todoCard.contactId) && todoCard.leadLabel === "Your calendar", JSON.stringify(todoCard));
      const todoDone = todoCard ? await confirm(todoCard) : null;
      const todoRow = await basePrisma.activity.findFirst({ where: { summary: todo }, select: { leadId: true, contactId: true, assignedToId: true, tenantId: true, type: true } });
      check("…and Confirm puts it on their own calendar, in their workspace", todoDone?.ok === true && todoRow?.leadId === null && todoRow.contactId === null && todoRow.assignedToId === memberA.id && todoRow.tenantId === a.tenantId && todoRow.type === "todo", JSON.stringify({ todoDone, todoRow }));

      // ── the meeting DAX refused: Mariska, no surname, not in the CRM ─────
      const mariska = `Meeting with Mariska — Atlantic Beach ${SFX} ${mode}`;
      // A colleague is invited through scheduleActivity's nested attendee write, which the db.ts guard refuses for
      // EVERY meeting under enforcement (documented there, until composite FKs land) — so only with it off.
      const invite = enforcing ? [] : [ownerA.name];
      const [meetingCard] = await cardsFor([{ type: "meeting", when: ahead(day, 11), minutes: 45, ...(invite.length ? { with: invite } : {}), summary: mariska }]);
      check(`a meeting with someone not in the CRM is a card${enforcing ? "" : ", with the colleague invited"}`, meetingCard?.kind === "meeting" && meetingCard.leadId === null && (enforcing || meetingCard.attendeeIds.includes(ownerA.id)), JSON.stringify(meetingCard));
      const meetingDone = meetingCard ? await confirm(meetingCard) : null;
      const meetingRow = await basePrisma.activity.findFirst({
        where: { summary: mariska },
        select: { type: true, leadId: true, contactId: true, tenantId: true, dueDate: true, endDate: true, attendees: { select: { userId: true } } },
      });
      check(`…booked: 45 minutes, on nobody, in their workspace${enforcing ? "" : ", with the colleague"}`, meetingDone?.ok === true && meetingRow?.type === "meeting" && meetingRow.leadId === null && meetingRow.contactId === null && meetingRow.tenantId === a.tenantId && (enforcing || meetingRow.attendees.some((x) => x.userId === ownerA.id)) && meetingRow.endDate !== null && meetingRow.endDate.getTime() - meetingRow.dueDate.getTime() === 45 * 60_000, JSON.stringify({ meetingDone, meetingRow }));

      // ── a follow-up on a customer with no deal ───────────────────────────
      const call = `Call about service ${SFX} ${mode}`;
      const [callCard] = await cardsFor([{ type: "follow_up", contactId: a.rows.contactId, when: ahead(day, 14), activity: "call", summary: call }]);
      check("a follow-up on a customer is a card on that customer", callCard?.kind === "follow_up" && callCard.leadId === null && callCard.contactId === a.rows.contactId && callCard.leadLabel === nameA, JSON.stringify(callCard));
      if (callCard) await confirm(callCard);
      const callRow = await basePrisma.activity.findFirst({ where: { summary: call }, select: { leadId: true, contactId: true, tenantId: true } });
      check("…and Confirm puts it on the customer", callRow?.contactId === a.rows.contactId && callRow.leadId === null && callRow.tenantId === a.tenantId, JSON.stringify(callRow));

      // ── another workspace's customer ─────────────────────────────────────
      const problems: string[] = [];
      const foreign = await cardsFor([{ type: "follow_up", contactId: b.rows.contactId, when: ahead(day, 15), activity: "call", summary: `Foreign ${SFX}` }], problems);
      check("another workspace's customer is never a card", foreign.length === 0 && problems.some((p) => /can't open that customer/.test(p)), JSON.stringify({ foreign, problems }));
      const forged = `Forged ${SFX} ${mode}`;
      const forgedDone = await confirm({ id: "forged", kind: "follow_up", leadId: null, contactId: b.rows.contactId, leadLabel: "B", title: forged, when: ahead(day, 16), activity: "call", summary: forged });
      check("…and a forged card naming one books nothing", forgedDone.ok === false && (await basePrisma.activity.count({ where: { summary: forged } })) === 0, JSON.stringify(forgedDone));

      // ── a test drive with no demo vehicle ────────────────────────────────
      const branch = `Atlantic Beach ${SFX} ${mode}`;
      {
        // Said nowhere, and never booked before by this person (A's owner; the fixture's test drive is the member's):
        // asked, not guessed.
        const asked: string[] = [];
        const none = await actAsStaff(a, () => resolveActions(ownerA, [{ type: "test_drive", leadId: a.rows.leadId, when: ahead(day, 10) }], asked), { asOwner: true, enforcing });
        check("a test drive with no branch said and none booked before is a question", none.length === 0 && asked.includes("Which branch or location is the test drive at?"), JSON.stringify({ none, asked }));
      }
      const [driveCard] = await cardsFor([{ type: "test_drive", leadId: a.rows.leadId, when: ahead(day, 12), minutes: 30, branch }]);
      check("a test drive on the deal with NO demo vehicle is a card", driveCard?.kind === "test_drive" && driveCard.demoVehicleId === null && driveCard.branch === branch && driveCard.leadId === a.rows.leadId, JSON.stringify(driveCard));
      const driveDone = driveCard ? await confirm(driveCard) : null;
      const driveRow = await basePrisma.testDriveBooking.findFirst({ where: { branch }, select: { demoVehicleId: true, leadId: true, contactId: true, salespersonId: true, tenantId: true } });
      check("…and Confirm books it: no demo vehicle, on the deal and its customer", driveDone?.ok === true && driveRow?.demoVehicleId === null && driveRow.leadId === a.rows.leadId && driveRow.contactId === a.rows.contactId && driveRow.salespersonId === memberA.id && driveRow.tenantId === a.tenantId, JSON.stringify({ driveDone, driveRow }));
      const [directCard] = await cardsFor([{ type: "test_drive", contactId: a.rows.contactId, when: ahead(day, 15), minutes: 30 }]);
      check("on the customer directly, with no branch said: where they last booked one", directCard?.kind === "test_drive" && directCard.leadId === null && directCard.contactId === a.rows.contactId && directCard.branch === branch, JSON.stringify(directCard));
      const directDone = directCard ? await confirm(directCard) : null;
      check("…and Confirm books that too", directDone?.ok === true && (await basePrisma.testDriveBooking.count({ where: { branch, leadId: null, contactId: a.rows.contactId } })) === 1, JSON.stringify(directDone));
    }
  } finally {
    __setTenantEnforcingForTests(null);
    const tenants = [a.tenantId, b.tenantId];
    await basePrisma.testDriveBooking.deleteMany({ where: { tenantId: { in: tenants } } });
    await basePrisma.activity.deleteMany({ where: { OR: [{ tenantId: { in: tenants } }, { summary: { contains: SFX } }] } });
    await teardown(fixture);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => basePrisma.$disconnect());
