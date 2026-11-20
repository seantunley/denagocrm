/**
 * TRANSFER A VEHICLE AND ITS WARRANTY TO A NEW OWNER (warranty-transfer-brief.md, PR 1).
 *
 * On a real, migrated database, through the real transfer and undo (lib/vehicleOwnership.ts) as the workspace owner:
 *  - every vehicle gets exactly one current owner row, by the database's own trigger, whatever creates it;
 *  - a transfer closes one row and opens one, moves Vehicle.contactId — and changes no warranty date, moves no claim,
 *    service or job card, and leaves each claim naming its original claimant;
 *  - two transfers at the same moment: exactly one lands, and there is still exactly one current owner;
 *  - undo puts it back and keeps the undone row, marked; refused once the new owner has a service;
 *  - another workspace can neither transfer nor undo it;
 *  - deleting a PREVIOUS owner leaves the vehicle and every row of its history;
 *  - across the whole database, every vehicle has exactly one current owner.
 *
 *   npm run test:vehicle-transfer     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes what it creates.
 */
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { transferVehicleOwnership, undoLastTransfer } from "../src/lib/vehicleOwnership";
import { seedTwoTenants, teardown } from "./harness/seed";
import { actAsStaff } from "./harness/actAs";

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

const day = (iso: string) => new Date(`${iso}T00:00:00`);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`vt${SFX}`);
  const { a, b } = fixture;
  const A = a.tenantId;
  const B = b.tenantId;
  const asOwner = <T>(tenant: typeof a, work: () => Promise<T>) =>
    actAsStaff(tenant, () => runInTenantScope({ tenantId: tenant.tenantId, system: false }, work), { asOwner: true });
  const actor = { id: a.ownerUserId, name: "Harness owner" };
  const openRows = (vehicleId: string) => basePrisma.vehicleOwnership.findMany({ where: { vehicleId, ownedUntil: null } });

  try {
    const contact = (name: string) => basePrisma.contact.create({ data: { tenantId: A, firstName: `${name} ${SFX}` }, select: { id: true } });
    const first = a.rows.contactId;
    const [second, third, fourth] = [await contact("Second"), await contact("Third"), await contact("Fourth")];
    const vehicle = await basePrisma.vehicle.create({
      data: { tenantId: A, model: `Transfer cart ${SFX}`, contactId: first, purchaseDate: day("2025-01-01"), warrantyMonths: 24 },
      select: { id: true },
    });

    // The trigger: a vehicle created by any path starts with its first owner.
    const born = await openRows(vehicle.id);
    check("a new vehicle has exactly one current owner row, for its contact, from its purchase date", born.length === 1 && born[0].contactId === first && born[0].reason === "registered" && born[0].tenantId === A && born[0].ownedFrom.getTime() === day("2025-01-01").getTime());

    // History before the transfer: a claim by the first owner and a service.
    const claim = await basePrisma.warrantyClaim.create({ data: { tenantId: A, vehicleId: vehicle.id, contactId: first, description: `Fault ${SFX}`, claimedAt: day("2025-06-01") }, select: { id: true } });
    await basePrisma.serviceRecord.create({ data: { tenantId: A, vehicleId: vehicle.id, summary: `First service ${SFX}`, serviceDate: day("2025-07-01") } });
    const before = await basePrisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id }, select: { purchaseDate: true, warrantyMonths: true } });

    const moved = await asOwner(a, () =>
      transferVehicleOwnership({ tenantId: A, vehicleId: vehicle.id, newContactId: second.id, date: day("2026-01-10"), reason: "sold_privately", odometerKm: 1200, note: null, proofDocumentId: null, actor }),
    );
    const rows = await basePrisma.vehicleOwnership.findMany({ where: { vehicleId: vehicle.id }, orderBy: { ownedFrom: "asc" } });
    const after = await basePrisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id }, select: { contactId: true, purchaseDate: true, warrantyMonths: true } });
    check("a transfer closes the old row on the date and opens one for the new owner", rows.length === 2 && rows[0].ownedUntil?.getTime() === day("2026-01-10").getTime() && rows[1].contactId === second.id && rows[1].ownedUntil === null && moved.toContactId === second.id);
    check("…Vehicle.contactId is the new owner", after.contactId === second.id);
    check("…the warranty dates are identical", after.purchaseDate?.getTime() === before.purchaseDate?.getTime() && after.warrantyMonths === before.warrantyMonths);
    const claimNow = await basePrisma.warrantyClaim.findUniqueOrThrow({ where: { id: claim.id }, select: { contactId: true, vehicleId: true } });
    check("…the claim stays on the vehicle, naming its original claimant", claimNow.vehicleId === vehicle.id && claimNow.contactId === first);
    check("…the service stays on the vehicle", (await basePrisma.serviceRecord.count({ where: { vehicleId: vehicle.id } })) === 1);
    check("…the odometer at handover is a mileage reading", (await basePrisma.mileageLog.count({ where: { vehicleId: vehicle.id, km: 1200 } })) === 1);
    check("…and it is audited", (await basePrisma.auditLog.count({ where: { tenantId: A, action: "vehicle.transferred" } })) >= 1);

    // Refusals.
    const refused = async (work: () => Promise<unknown>) => { try { await work(); return ""; } catch (error) { return message(error); } };
    check("a transfer to the current owner is refused", /already owns/.test(await refused(() => asOwner(a, () => transferVehicleOwnership({ tenantId: A, vehicleId: vehicle.id, newContactId: second.id, date: day("2026-02-01"), reason: "other", odometerKm: null, note: null, proofDocumentId: null, actor })))));
    check("a transfer dated before the current owner took over is refused", /before the current owner/.test(await refused(() => asOwner(a, () => transferVehicleOwnership({ tenantId: A, vehicleId: vehicle.id, newContactId: third.id, date: day("2025-12-01"), reason: "other", odometerKm: null, note: null, proofDocumentId: null, actor })))));
    const tomorrow = new Date(Date.now() + 86_400_000);
    check("a transfer dated in the future is refused", /future/.test(await refused(() => asOwner(a, () => transferVehicleOwnership({ tenantId: A, vehicleId: vehicle.id, newContactId: third.id, date: tomorrow, reason: "other", odometerKm: null, note: null, proofDocumentId: null, actor })))));

    // Two at once, each from the owner its dialog showed (the second): exactly one lands.
    const race = await Promise.allSettled([third.id, fourth.id].map((newContactId) =>
      asOwner(a, () => transferVehicleOwnership({ tenantId: A, vehicleId: vehicle.id, newContactId, expectedOwnerId: second.id, date: day("2026-03-01"), reason: "sold_privately", odometerKm: null, note: null, proofDocumentId: null, actor })),
    ));
    const landed = race.filter((r) => r.status === "fulfilled").length;
    const open = await openRows(vehicle.id);
    const winner = await basePrisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id }, select: { contactId: true } });
    check("two transfers at once: exactly one lands", landed === 1, race.map((r) => (r.status === "rejected" ? message(r.reason) : "ok")).join(" | "));
    check("…and there is still exactly one current owner, the vehicle's", open.length === 1 && open[0].contactId === winner.contactId);

    // Undo: back to the second owner, the undone row kept and marked.
    await asOwner(a, () => undoLastTransfer({ tenantId: A, vehicleId: vehicle.id, actor }));
    const undone = await basePrisma.vehicleOwnership.findMany({ where: { vehicleId: vehicle.id }, orderBy: { createdAt: "asc" } });
    const backTo = await basePrisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id }, select: { contactId: true } });
    check("undo gives it back to the previous owner", backTo.contactId === second.id && (await openRows(vehicle.id))[0]?.contactId === second.id);
    check("…the undone row is kept, marked", undone.some((row) => row.reversedAt && row.contactId === winner.contactId && row.ownedUntil));

    // Undo refused once the new owner has a service.
    await asOwner(a, () => transferVehicleOwnership({ tenantId: A, vehicleId: vehicle.id, newContactId: third.id, date: day("2026-04-01"), reason: "traded_in", odometerKm: null, note: null, proofDocumentId: null, actor }));
    await basePrisma.serviceRecord.create({ data: { tenantId: A, vehicleId: vehicle.id, summary: `New owner's service ${SFX}`, serviceDate: day("2026-04-15") } });
    const blocked = await refused(() => asOwner(a, () => undoLastTransfer({ tenantId: A, vehicleId: vehicle.id, actor })));
    check("undo is refused once the new owner has a service, saying why", /1 service/.test(blocked), blocked);
    check("…and nothing changed", (await basePrisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id }, select: { contactId: true } })).contactId === third.id);

    // Another workspace.
    const fromB = await refused(() => asOwner(b, () => transferVehicleOwnership({ tenantId: B, vehicleId: vehicle.id, newContactId: b.rows.contactId, date: day("2026-05-01"), reason: "other", odometerKm: null, note: null, proofDocumentId: null, actor: { id: b.ownerUserId, name: "B owner" } })));
    check("another workspace cannot transfer it", Boolean(fromB) && (await basePrisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id }, select: { contactId: true } })).contactId === third.id, fromB);
    check("another workspace cannot undo it", Boolean(await refused(() => asOwner(b, () => undoLastTransfer({ tenantId: B, vehicleId: vehicle.id, actor: { id: b.ownerUserId, name: "B owner" } })))));
    check("a contact of another workspace can't be the new owner", Boolean(await refused(() => asOwner(a, () => transferVehicleOwnership({ tenantId: A, vehicleId: vehicle.id, newContactId: b.rows.contactId, date: day("2026-05-01"), reason: "other", odometerKm: null, note: null, proofDocumentId: null, actor })))));

    // Deleting a previous owner (the second) leaves the vehicle and its whole history.
    const historyBefore = await basePrisma.vehicleOwnership.count({ where: { vehicleId: vehicle.id } });
    await basePrisma.contact.delete({ where: { id: second.id } });
    const still = await basePrisma.vehicle.findUnique({ where: { id: vehicle.id }, select: { contactId: true } });
    check("deleting a previous owner leaves the vehicle with its owner", still?.contactId === third.id);
    check("…every ownership row stays, theirs without the person", (await basePrisma.vehicleOwnership.count({ where: { vehicleId: vehicle.id } })) === historyBefore && (await basePrisma.vehicleOwnership.count({ where: { vehicleId: vehicle.id, contactId: null } })) >= 1);
    check("…and the claims and services stay", (await basePrisma.warrantyClaim.count({ where: { vehicleId: vehicle.id } })) === 1 && (await basePrisma.serviceRecord.count({ where: { vehicleId: vehicle.id } })) === 2);

    // The whole database: every vehicle has exactly one current owner.
    const wrong = await basePrisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "Vehicle" v
      WHERE (SELECT count(*) FROM "VehicleOwnership" o WHERE o."vehicleId" = v."id" AND o."ownedUntil" IS NULL) <> 1`;
    check("every vehicle in the database has exactly one current owner", wrong[0]?.n === 0, `${wrong[0]?.n} wrong`);
  } finally {
    for (const tenantId of [A, B]) {
      await basePrisma.mileageLog.deleteMany({ where: { tenantId } }).catch(() => 0);
      await basePrisma.serviceRecord.deleteMany({ where: { tenantId } }).catch(() => 0);
      await basePrisma.warrantyClaim.deleteMany({ where: { tenantId } }).catch(() => 0);
      await basePrisma.vehicleOwnership.deleteMany({ where: { tenantId } }).catch(() => 0);
    }
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
