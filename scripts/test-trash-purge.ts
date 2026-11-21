/**
 * REAL-DATABASE proof that the 60-day trash purge works again (2026-11-21; migration 20261121100000).
 *
 *   npm run test:trash-purge     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 *  - a contact trashed over 60 days ago WITH audit history is deleted for good; the audit rows stay, unlinked
 *    (before the migration one audit row blocked the delete, and the purge swallowed the error every night);
 *  - a contact with a filed document stays in the trash, document and all — paperwork keeps its record;
 *  - a contact trashed recently is untouched; nothing lands in the error log.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates.
 */
import { basePrisma } from "../src/lib/db";
import { purgeTrash } from "../src/lib/trash";
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

const DAY = 86_400_000;

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`tp${SFX}`);
  const A = fixture.a.tenantId;
  const contactIds: string[] = [];
  const auditIds: string[] = [];
  let documentId: string | null = null;
  const vehicleIds: string[] = [];
  const since = new Date();
  try {
    const trashed = async (name: string, daysAgo: number) => {
      const c = await basePrisma.contact.create({
        data: { tenantId: A, firstName: `${name} ${SFX}`, deletedAt: new Date(Date.now() - daysAgo * DAY), deleteReason: "test", deletedByName: "Harness" },
        select: { id: true },
      });
      contactIds.push(c.id);
      return c.id;
    };
    const withHistory = await trashed("Old with history", 61);
    const audit = await basePrisma.auditLog.create({
      data: { tenantId: A, contactId: withHistory, action: "contact.updated", summary: `Harness history ${SFX}`, userName: "Harness" },
      select: { id: true },
    });
    auditIds.push(audit.id);
    const withPaper = await trashed("Old with paperwork", 61);
    documentId = (await basePrisma.document.create({
      data: { tenantId: A, contactId: withPaper, fileName: "invoice.pdf", storedName: `harness-${SFX}.pdf`, mimeType: "application/pdf", sizeBytes: 1, uploadedById: fixture.a.ownerUserId },
      select: { id: true },
    })).id;
    const recent = await trashed("Recent", 5);
    // A customer with a sale (lib/contactKeep.ts, review of #1170): one who still owns a vehicle, and one who owned
    // a vehicle before — now someone else's. Both stay in the trash, with the vehicle and its history.
    const owner = await trashed("Old owner of a vehicle", 61);
    const formerOwner = await trashed("Old former owner", 61);
    const keeper = await basePrisma.contact.create({ data: { tenantId: A, firstName: `Current keeper ${SFX}` }, select: { id: true } });
    contactIds.push(keeper.id);
    const owned = await basePrisma.vehicle.create({ data: { tenantId: A, contactId: owner, model: `Harness cart ${SFX}` }, select: { id: true } });
    const sold = await basePrisma.vehicle.create({ data: { tenantId: A, contactId: keeper.id, model: `Harness sold cart ${SFX}` }, select: { id: true } });
    vehicleIds.push(owned.id, sold.id);
    await basePrisma.vehicleOwnership.create({
      data: { tenantId: A, vehicleId: sold.id, contactId: formerOwner, ownedFrom: new Date("2025-01-01"), ownedUntil: new Date("2025-06-01"), reason: "registered" },
    });

    await purgeTrash();

    const left = new Set((await basePrisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true } })).map((c) => c.id));
    check("a contact past 60 days with audit history is deleted for good", !left.has(withHistory));
    const kept = await basePrisma.auditLog.findUnique({ where: { id: audit.id }, select: { contactId: true, tenantId: true } });
    check("its audit history stays, unlinked, in its workspace", kept?.contactId === null && kept?.tenantId === A, JSON.stringify(kept));
    check("a contact with a filed document stays in the trash", left.has(withPaper));
    check("and so does the document", Boolean(await basePrisma.document.findUnique({ where: { id: documentId }, select: { id: true } })));
    check("a recently trashed contact is untouched", left.has(recent));
    check("a customer who owns a vehicle stays in the trash", left.has(owner));
    check("and their vehicle is untouched", Boolean(await basePrisma.vehicle.findUnique({ where: { id: owned.id }, select: { id: true } })));
    check("a customer who owned a vehicle before stays in the trash", left.has(formerOwner));
    const errors = await basePrisma.errorLog.count({ where: { scope: "trash-purge", createdAt: { gte: since } } });
    check("nothing failed (the error log has no purge entry)", errors === 0, `${errors} entries`);
  } finally {
    if (documentId) await basePrisma.document.deleteMany({ where: { id: documentId } });
    // Vehicles first: their ownership rows go with them, then the contacts are free to go.
    await basePrisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
    await basePrisma.auditLog.deleteMany({ where: { id: { in: auditIds } } });
    await basePrisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await teardown(fixture);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().then(() => basePrisma.$disconnect()).catch(async (err) => {
  console.error(err);
  await basePrisma.$disconnect();
  process.exit(1);
});
