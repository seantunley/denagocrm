/**
 * REAL-DATABASE proof of DAX's `invoices` lookup (assistantInvoicesLookup.ts) — held to the Invoices page's rule.
 *
 *   npm run test:assistant-invoices     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * On the SCOPED client with enforcement on:
 *  - the owner sees every issued invoice, with owing = total less deposit and payments, and the outstanding total
 *    PER CURRENCY (rand and dollars never added together);
 *  - a rep who may open only their own quotes sees only their own invoice;
 *  - someone without deliveries.view is refused; with Automotive off, refused;
 *  - the Xero filter reads the Xero copy; the other workspace sees nothing of A's;
 *  - a payment reference never appears in the answer. And nothing is written.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates.
 */
import crypto from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { invoicesLookup, type InvoicesArgs } from "../src/lib/assistantInvoicesLookup";
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

const invNo = () => 700_000_000 + crypto.randomInt(200_000_000);
type Row = { invoice?: string; quote?: string; customer?: string; owing?: string; paid?: boolean; xero?: string; total?: number; outstanding?: string; note?: string };

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`inv${SFX}`);
  const { a, b } = fixture;
  const A = a.tenantId;
  const user = (name: string): PermissionUser => ({ id: crypto.randomUUID(), name, email: `${name.toLowerCase().replace(/\W/g, "")}.${SFX}@harness.invalid`, role: "member" });
  const rep = user("Inv Rep");
  const noAccess = user("Inv Nobody");
  const ownerA: PermissionUser = { id: a.ownerUserId, name: "Harness A owner", email: "", role: "owner" };
  const ownerB: PermissionUser = { id: b.ownerUserId, name: "Harness B owner", email: "", role: "owner" };
  const REP_ROLE = crypto.randomUUID();
  const NO_ROLE = crypto.randomUUID();
  const savedModules = (await basePrisma.tenant.findUnique({ where: { id: A }, select: { modules: true } }))?.modules ?? "";
  const quoteIds: string[] = [];
  const contactIds: string[] = [];

  try {
    await basePrisma.tenant.update({ where: { id: A }, data: { modules: [...new Set([...savedModules.split(","), "automotive"])].filter(Boolean).join(",") } });
    for (const u of [rep, noAccess]) {
      await basePrisma.$executeRaw`INSERT INTO "User" ("id","name","email","passwordHash","role","sessionVersion") VALUES (${u.id}, ${u.name}, ${u.email}, 'x', 'member', 0)`;
      await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id","tenantId","userId") VALUES (${crypto.randomUUID()}, ${A}, ${u.id})`;
    }
    for (const [role, keys, holder] of [
      [REP_ROLE, ["deliveries.view", "quotes.view_owned", "leads.view_owned", "contacts.view_owned"], rep],
      [NO_ROLE, ["quotes.view_owned", "leads.view_owned", "contacts.view_owned"], noAccess],
    ] as const) {
      await basePrisma.$executeRaw`INSERT INTO "Role" ("id","tenantId","name","description","system","updatedAt") VALUES (${role}, ${A}, ${`Invoices ${role.slice(0, 8)} ${SFX}`}, 'test', false, now())`;
      for (const key of keys) await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId","permissionKey","tenantId") VALUES (${role}, ${key}, ${A})`;
      await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id","userId","roleId","tenantId") VALUES (${crypto.randomUUID()}, ${holder.id}, ${role}, ${A})`;
    }
    const contact = async (first: string, tenantId = A, ownerId: string | null = null) => {
      const c = await basePrisma.contact.create({ data: { tenantId, firstName: first, lastName: `Inv${SFX}`, ownerId }, select: { id: true } });
      contactIds.push(c.id);
      return c.id;
    };
    const invoice = async (opts: { tenantId?: string; contactId: string; createdById: string; cents: number; currency?: string | null; depositCents?: number; xero?: boolean }) => {
      const q = await basePrisma.quote.create({
        data: {
          tenantId: opts.tenantId ?? A, number: invNo(), status: "accepted", contactId: opts.contactId, createdById: opts.createdById,
          invoiceNumber: invNo(), invoicedAt: new Date(Date.now() - 40 * 86_400_000), taxInclusive: true, currency: opts.currency ?? null,
          ...(opts.depositCents ? { depositPaidAt: new Date(), depositPaidCents: opts.depositCents } : {}),
          ...(opts.xero ? { xeroInvoiceId: `x-${SFX}`, xeroInvoiceNumber: `XINV-${SFX}`, xeroStatus: "AUTHORISED", xeroSentAt: new Date() } : {}),
        },
        select: { id: true, number: true },
      });
      quoteIds.push(q.id);
      await basePrisma.quoteItem.createMany({ data: [{ quoteId: q.id, tenantId: opts.tenantId ?? A, description: `Rover ${SFX}`, qty: 1, unitPriceCents: opts.cents }] });
      return q;
    };

    // The rep's own: R100 000, R40 000 paid (with a reference that must never show), and in Xero.
    const repQuote = await invoice({ contactId: await contact("Repcust", A, rep.id), createdById: rep.id, cents: 10_000_000, xero: true });
    await basePrisma.quotePayment.create({ data: { tenantId: A, quoteId: repQuote.id, amountCents: 4_000_000, receivedAt: new Date(), method: "eft", reference: `SECRETREF${SFX}`, createdByName: "Test" } });
    // The owner's, on a customer the rep can't open: $5 000 owing.
    const usd = await invoice({ contactId: await contact("Dollarcust"), createdById: a.ownerUserId, cents: 500_000, currency: "USD" });
    // Paid in full by its deposit.
    await invoice({ contactId: await contact("Paidcust"), createdById: a.ownerUserId, cents: 3_000_000, depositCents: 3_000_000 });
    // The other workspace's own invoice.
    await invoice({ tenantId: b.tenantId, contactId: await contact("Othercust", b.tenantId), createdById: b.ownerUserId, cents: 7_000_000 });

    const counts = async () => (await basePrisma.$queryRaw<{ n: number }[]>`SELECT ((SELECT count(*) FROM "Quote") + (SELECT count(*) FROM "QuotePayment"))::int AS n`)[0].n;
    const run = async (tenantId: string, u: PermissionUser, args: InvoicesArgs) =>
      (await runInTenantScope({ tenantId, system: false }, () => invoicesLookup(u, args))).data as Row[];
    const mine = (rows: Row[]) => rows.slice(1).filter((r) => r.customer?.includes(`Inv${SFX}`));

    __setTenantEnforcingForTests(true);
    const before = await counts();

    console.log("\ninvoices — the owner");
    const owner = await run(A, ownerA, { status: "any", limit: 60 });
    const ownRows = mine(owner);
    check("sees all three of A's issued invoices", ownRows.length === 3, JSON.stringify(ownRows.map((r) => r.customer)));
    const repRow = ownRows.find((r) => r.quote === `Q-${repQuote.number}`);
    check("owing = total less the payment: R60 000", /60[\s ,.]?000/.test(repRow?.owing ?? ""), repRow?.owing);
    check("the paid one says paid", ownRows.some((r) => r.customer?.startsWith("Paidcust") && r.paid === true));
    const unpaid = await run(A, ownerA, { customer: `Inv${SFX}`, limit: 60 });
    check("unpaid (the default): the two still owing", unpaid[0].total === 2, String(unpaid[0].total));
    check("outstanding per currency, never added: rand AND dollars", /60[\s ,.]?000/.test(unpaid[0].outstanding ?? "") && /5[\s ,.]?000/.test(unpaid[0].outstanding ?? "") && (unpaid[0].outstanding ?? "").includes("+"), unpaid[0].outstanding);
    check("no due date is claimed", /no due date/i.test(unpaid[0].note ?? ""));
    const sent = await run(A, ownerA, { status: "any", xero: "sent", customer: `Inv${SFX}` });
    check("xero sent: only the one in Xero, with its number", sent[0].total === 1 && /XINV-/.test(sent[1]?.xero ?? ""), JSON.stringify(sent));
    const notSent = await run(A, ownerA, { status: "any", xero: "not_sent", customer: `Inv${SFX}` });
    check("xero not sent: the other two", notSent[0].total === 2);
    check("a payment reference never appears", !JSON.stringify([owner, unpaid, sent]).includes(`SECRETREF${SFX}`));

    console.log("\ninvoices — a rep who may open only their own");
    const repView = await run(A, rep, { status: "any", limit: 60 });
    check("only their own invoice", mine(repView).length === 1 && mine(repView)[0].quote === `Q-${repQuote.number}`, JSON.stringify(mine(repView).map((r) => r.quote)));
    check("…and never the dollar invoice they can't open", !JSON.stringify(repView).includes(`Q-${usd.number}`));
    const byNumber = await run(A, rep, { status: "any", number: `Q-${usd.number}` });
    check("not even asked for by number", !JSON.stringify(byNumber).includes("Dollarcust"));

    console.log("\ninvoices — refused");
    const refused = await run(A, noAccess, {});
    check("no deliveries.view: refused", /can't open Invoices/.test(refused[0].note ?? ""), refused[0].note);
    await basePrisma.tenant.update({ where: { id: A }, data: { modules: savedModules.split(",").filter((m) => m && m !== "automotive").join(",") } });
    const off = await run(A, ownerA, {});
    check("Automotive off: refused", /switched off/.test(off[0].note ?? ""), off[0].note);

    console.log("\ninvoices — the other workspace");
    const other = await run(b.tenantId, ownerB, { status: "any", limit: 60 });
    check("nothing of A's", !JSON.stringify(other).includes("Repcust") && !JSON.stringify(other).includes("Dollarcust"));

    check("READ-ONLY: nothing was written", (await counts()) === before);
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.tenant.update({ where: { id: A }, data: { modules: savedModules } }).catch(() => 0);
    await basePrisma.quotePayment.deleteMany({ where: { quoteId: { in: quoteIds } } }).catch(() => 0);
    await basePrisma.quoteItem.deleteMany({ where: { quoteId: { in: quoteIds } } }).catch(() => 0);
    await basePrisma.quote.deleteMany({ where: { id: { in: quoteIds } } }).catch(() => 0);
    await basePrisma.contact.deleteMany({ where: { id: { in: contactIds } } }).catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "roleId" IN (${REP_ROLE}, ${NO_ROLE})`.catch(() => 0);
    await teardown(fixture);
    await basePrisma.$executeRaw`DELETE FROM "RolePermission" WHERE "roleId" IN (${REP_ROLE}, ${NO_ROLE})`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "Role" WHERE "id" IN (${REP_ROLE}, ${NO_ROLE})`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${rep.id}, ${noAccess.id})`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "User" WHERE "id" IN (${rep.id}, ${noAccess.id})`.catch(() => 0);
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
