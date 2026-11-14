/**
 * REAL-DATABASE proof of find_leads by the day a deal was WON or LOST (Sean, 2026-11-14: "a PDF report of lost leads
 * in October" listed leads CREATED in October, without a lost date or reason, and only 25 of them).
 *
 *   npm run test:assistant-lost-dates     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * On the SCOPED client with enforcement on:
 *  - status lost + closedFrom/closedTo finds deals LOST in the month — one created in September and lost in October
 *    included, one created in October and lost in November not;
 *  - each lists its closed date and lost reason; lostReasons counts EVERY match, not just those listed;
 *  - won + closedFrom/closedTo reads wonAt; a list of more than 25 for a report;
 *  - the other workspace sees nothing of A's.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates.
 */
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { findLeads } from "../src/lib/crmAssistant";
import { leadArgs } from "../src/lib/crmAssistantPlan";
import type { PermissionUser } from "../src/lib/permissions";
import { seedTwoTenants, teardown } from "./harness/seed";

const SFX = Math.random().toString(16).slice(2, 10);
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
}

type Row = { customer?: string; closed?: string; lostReason?: string; total?: number; listed?: number; lostReasons?: { reason: string; count: number }[] };
const at = (iso: string) => new Date(`${iso}T10:00:00+02:00`);

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`lsd${SFX}`);
  const { a, b } = fixture;
  const A = a.tenantId;
  const ownerA: PermissionUser = { id: a.ownerUserId, name: "Harness A owner", email: "", role: "owner" };
  const memberB: PermissionUser = { id: b.memberUserId, name: "Harness B member", email: "", role: "member" };
  const lead = (name: string, status: string, created: string, closed: string | null, lostReason: string | null = null) =>
    basePrisma.lead.create({
      data: {
        tenantId: A, stageId: a.rows.stageId, status, name: `${name} ${SFX}`, title: "Rover XL", valueCents: 23_500_000, createdById: a.ownerUserId,
        createdAt: at(created),
        ...(status === "lost" && closed ? { lostAt: at(closed), lostReason } : {}),
        ...(status === "won" && closed ? { wonAt: at(closed) } : {}),
      },
      select: { id: true },
    });

  await lead("Sept-made Oct-lost", "lost", "2026-09-20", "2026-10-05", "Price");
  await lead("Oct-made Oct-lost", "lost", "2026-10-02", "2026-10-20", "Price");
  await lead("Oct-made Oct-lost no reason", "lost", "2026-10-03", "2026-10-25", null);
  await lead("Oct-made Nov-lost", "lost", "2026-10-10", "2026-11-03", "Went with a competitor");
  await lead("Oct-won", "won", "2026-09-01", "2026-10-15");
  // 30 more lost in October with one reason: more than the old 25 cap.
  for (let i = 0; i < 30; i++) await lead(`Bulk ${i}`, "lost", "2026-08-01", "2026-10-12", "Timing");

  // REVIEW OF #1101, 1: more than 500 lost in September, all made more recently than the one lost LAST — made in 2025.
  await basePrisma.lead.createMany({
    data: Array.from({ length: 510 }, (_, i) => ({
      tenantId: A, stageId: a.rows.stageId, status: "lost", name: `Sept bulk ${i} ${SFX}`, title: "Rover XL", valueCents: 1_000_000,
      createdById: a.ownerUserId, createdAt: at("2026-08-20"), lostAt: at("2026-09-02"), lostReason: "Bulk",
    })),
  });
  await lead("Made 2025, lost 30 Sept", "lost", "2025-01-10", "2026-09-30", "Finance");
  await lead("Won 29 Sept, made 2025", "won", "2025-02-01", "2026-09-29");

  // REVIEW OF #1101, 2: two lost in July — one contacted two days ago, one never. "No contact for 30 days" is one.
  const touched = await lead("July lost, contacted", "lost", "2026-06-01", "2026-07-10", "Price");
  await lead("July lost, untouched", "lost", "2026-06-02", "2026-07-12", "Timing");
  await basePrisma.communication.create({ data: { tenantId: A, type: "whatsapp", direction: "inbound", body: `Still keen ${SFX}`, leadId: touched.id, userId: a.ownerUserId, occurredAt: new Date(Date.now() - 2 * 86_400_000) } });

  const run = (tenantId: string, u: PermissionUser, args: Record<string, unknown>) =>
    runInTenantScope({ tenantId, system: false }, () => findLeads(u, leadArgs.parse(args)));
  const rows = (out: { data: unknown[] }) => out.data as Row[];
  const mine = (r: Row[]) => r.slice(1).filter((x) => x.customer?.endsWith(SFX));

  try {
    __setTenantEnforcingForTests(true);

    console.log("\nLost in October, by the day they were lost");
    const oct = rows(await run(A, ownerA, { status: "lost", closedFrom: "2026-10-01", closedTo: "2026-10-31", limit: 60 }));
    const names = mine(oct).map((r) => r.customer);
    check("lost in October though made in September: included", names.includes(`Sept-made Oct-lost ${SFX}`), JSON.stringify(names.slice(0, 5)));
    check("made in October, lost in November: NOT included", !names.includes(`Oct-made Nov-lost ${SFX}`));
    check("the total counts all 33, and all are listed (no 25 cap)", oct[0].total === 33 && mine(oct).length === 33, `${oct[0].total} / ${mine(oct).length}`);
    const row = mine(oct).find((r) => r.customer === `Oct-made Oct-lost ${SFX}`);
    check("each lists the day it was lost and why", row?.closed === "2026-10-20" && row?.lostReason === "Price", JSON.stringify(row));
    check("…and says so when no reason was recorded", mine(oct).find((r) => r.customer === `Oct-made Oct-lost no reason ${SFX}`)?.lostReason === "no reason recorded");
    const reasons = Object.fromEntries((oct[0].lostReasons ?? []).map((r) => [r.reason, r.count]));
    check("lostReasons counts every match: Timing 30, Price 2, none 1", reasons.Timing === 30 && reasons.Price === 2 && reasons["no reason recorded"] === 1, JSON.stringify(oct[0].lostReasons));
    check("…and never a reason from outside the month", !("Went with a competitor" in reasons));
    const few = rows(await run(A, ownerA, { status: "lost", closedFrom: "2026-10-01", closedTo: "2026-10-31", limit: 5 }));
    check("a short list still gives the full total and every reason", few[0].total === 33 && mine(few).length === 5 && (few[0].lostReasons ?? []).length === 3);

    console.log("\nCreated in October (the old reading) is still its own question");
    const made = rows(await run(A, ownerA, { status: "lost", createdFrom: "2026-10-01", createdTo: "2026-10-31", limit: 60 }));
    check("created in October: the two made then, including the one lost in November", made[0].total === 3 && mine(made).some((r) => r.customer === `Oct-made Nov-lost ${SFX}`), JSON.stringify(made[0]));

    console.log("\nWon in October");
    const won = rows(await run(A, ownerA, { status: "won", closedFrom: "2026-10-01", closedTo: "2026-10-31" }));
    check("won reads the day it was won", won[0].total === 1 && mine(won)[0]?.closed === "2026-10-15" && !("lostReasons" in won[0]), JSON.stringify(won));
    const either = rows(await run(A, ownerA, { status: "any", closedFrom: "2026-10-01", closedTo: "2026-10-31", limit: 60 }));
    check("any status: closed either way in October (33 lost + 1 won)", either[0].total === 34, JSON.stringify(either[0]));

    console.log("\nMore than 500 matches: read by the day they closed (review of #1101)");
    const sept = rows(await run(A, ownerA, { status: "lost", closedFrom: "2026-09-01", closedTo: "2026-09-30", sort: "closed", limit: 60 }));
    check("the deal lost LAST, though made in 2025, leads the list", mine(sept)[0]?.customer === `Made 2025, lost 30 Sept ${SFX}`, JSON.stringify(mine(sept)[0]));
    check("…the total counts all 511", sept[0].total === 511, String(sept[0].total));
    const septAny = rows(await run(A, ownerA, { status: "any", closedFrom: "2026-09-01", closedTo: "2026-09-30", limit: 60 }));
    check("any status: the latest of both — lost 30 Sept, then won 29 Sept", mine(septAny)[0]?.customer === `Made 2025, lost 30 Sept ${SFX}` && mine(septAny)[1]?.customer === `Won 29 Sept, made 2025 ${SFX}`, JSON.stringify(mine(septAny).slice(0, 2).map((r) => r.customer)));

    console.log("\nReasons describe exactly the deals counted (review of #1101)");
    const quiet = rows(await run(A, ownerA, { status: "lost", closedFrom: "2026-07-01", closedTo: "2026-07-31", noContactDays: 30, limit: 60 }));
    check("no contact for 30 days: only the untouched one", quiet[0].total === 1 && mine(quiet).map((r) => r.customer).join() === `July lost, untouched ${SFX}`, JSON.stringify(quiet[0]));
    check("…and its reasons are only that one's: Timing 1, no Price", JSON.stringify(quiet[0].lostReasons) === JSON.stringify([{ reason: "Timing", count: 1 }]), JSON.stringify(quiet[0].lostReasons));
    const july = rows(await run(A, ownerA, { status: "lost", closedFrom: "2026-07-01", closedTo: "2026-07-31" }));
    check("without the filter: both, and both reasons", july[0].total === 2 && (july[0].lostReasons ?? []).length === 2, JSON.stringify(july[0]));

    console.log("\nThe other workspace");
    const other = rows(await run(b.tenantId, memberB, { status: "lost", closedFrom: "2026-10-01", closedTo: "2026-10-31", limit: 60 }));
    check("nothing of A's", !JSON.stringify(other).includes(SFX));
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.communication.deleteMany({ where: { tenantId: A, body: `Still keen ${SFX}` } }).catch(() => 0);
    await basePrisma.lead.deleteMany({ where: { tenantId: A, name: { endsWith: SFX } } }).catch(() => 0);
    await teardown(fixture);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch((error) => {
    failed++;
    console.error(error);
  })
  .finally(async () => {
    await basePrisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
