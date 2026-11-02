/**
 * REAL-DATABASE proof of DAX's `lost_alive` lookup (assistantLostAliveLookup.ts): "which lost deals are still alive?"
 *
 *   npm run test:assistant-lost-alive     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * Review of #950: leads and quotes are separate permissions. On the SCOPED client with enforcement on:
 *  - a salesperson who may open their deals but NOT quotes: a deal whose only sign of life is a quote view is not
 *    listed, and no quote number appears anywhere in the answer; a deal the customer messaged about still is;
 *  - a salesperson who may open their own quotes: their deal is listed with "opened quote Q-…";
 *  - the owner: the first deal is listed with its quote view;
 *  - the OTHER workspace: nothing of A's.
 * And that the lookup writes nothing.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates. The model
 * is never called; nobody is contacted.
 */
import crypto from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { lostAliveLookup } from "../src/lib/assistantLostAliveLookup";
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

const DAY = 86_400_000;
const T0 = Date.now();
const ago = (ms: number) => new Date(T0 - ms);
const quoteNo = () => 100_000_000 + crypto.randomInt(800_000_000);
const digest = () => crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");

type Deals = { deals: { leadId: string; since: string[] }[] };

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`lal${SFX}`);
  const { a, b } = fixture;
  const A = a.tenantId;
  const user = (name: string): PermissionUser => ({ id: crypto.randomUUID(), name, email: `${name.toLowerCase().replace(/\W/g, "")}.${SFX}@harness.invalid`, role: "member" });
  const repLeads = user("Rep Leads");
  const repQuotes = user("Rep Quotes");
  const ownerA: PermissionUser = { id: a.ownerUserId, name: "Harness A owner", email: "", role: "owner" };
  const memberB: PermissionUser = { id: b.memberUserId, name: "Harness B member", email: "", role: "member" };
  const LEADS_ONLY = crypto.randomUUID();
  const WITH_QUOTES = crypto.randomUUID();

  for (const u of [repLeads, repQuotes]) {
    await basePrisma.$executeRaw`INSERT INTO "User" ("id","name","email","passwordHash","role","sessionVersion") VALUES (${u.id}, ${u.name}, ${u.email}, 'x', 'member', 0)`;
    await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id","tenantId","userId") VALUES (${crypto.randomUUID()}, ${A}, ${u.id})`;
  }
  for (const [role, keys, holder] of [
    [LEADS_ONLY, ["leads.view_owned", "contacts.view_owned"], repLeads],
    [WITH_QUOTES, ["leads.view_owned", "contacts.view_owned", "quotes.view_owned"], repQuotes],
  ] as const) {
    await basePrisma.$executeRaw`INSERT INTO "Role" ("id","tenantId","name","description","system","updatedAt") VALUES (${role}, ${A}, ${`Lost alive ${role.slice(0, 8)} ${SFX}`}, 'test', false, now())`;
    for (const key of keys) await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId","permissionKey","tenantId") VALUES (${role}, ${key}, ${A})`;
    await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id","userId","roleId","tenantId") VALUES (${crypto.randomUUID()}, ${holder.id}, ${role}, ${A})`;
  }

  const lostLead = (first: string, assignedToId: string, lostReason: string, contactId: string) =>
    basePrisma.lead.create({ data: {
      tenantId: A, stageId: a.rows.stageId, status: "lost", name: `${first} Lost${SFX}`, title: "Rover XL", valueCents: 18_000_000,
      contactId, assignedToId, createdById: assignedToId, createdAt: ago(40 * DAY), lostAt: ago(10 * DAY), lostReason,
    }, select: { id: true } });
  const contact = (first: string, ownerId: string) =>
    basePrisma.contact.create({ data: { tenantId: A, firstName: first, lastName: `Lost${SFX}`, ownerId }, select: { id: true } });

  // Kim: the rep without quote access; her only sign of life is opening her quote (and its signing link).
  const kim = await contact("Kim", repLeads.id);
  const kimLead = await lostLead("Kim", repLeads.id, "Went quiet", kim.id);
  const kq = await basePrisma.quote.create({ data: { tenantId: A, number: quoteNo(), status: "sent", leadId: kimLead.id, contactId: kim.id, createdById: repLeads.id, createdAt: ago(20 * DAY), viewedAt: ago(2 * DAY) }, select: { id: true, number: true } });
  const request = await basePrisma.signatureRequest.create({ data: { tenantId: A, title: `Q-${kq.number}`, status: "viewed", sentAt: ago(20 * DAY), quoteId: kq.id }, select: { id: true } });
  const signer = await basePrisma.signatureRecipient.create({ data: { tenantId: A, requestId: request.id, name: "Kim", email: `kim.${SFX}@customer.invalid`, role: "signer", status: "viewed", token: digest(), viewedAt: ago(2 * DAY) }, select: { id: true } });
  await basePrisma.signatureView.create({ data: { tenantId: A, requestId: request.id, recipientId: signer.id, startedAt: ago(1 * DAY), lastSeenAt: ago(1 * DAY) } });

  // Lia: the same rep; the customer messaged since — no quote involved.
  const lia = await contact("Lia", repLeads.id);
  const liaLead = await lostLead("Lia", repLeads.id, "Timing - next year", lia.id);
  await basePrisma.communication.create({ data: { tenantId: A, type: "whatsapp", direction: "inbound", body: `Still keen? ${SFX}`, leadId: liaLead.id, contactId: lia.id, userId: a.ownerUserId, occurredAt: ago(1 * DAY) } });

  // Max: the rep WITH quote access; he opened his quote.
  const max = await contact("Max", repQuotes.id);
  const maxLead = await lostLead("Max", repQuotes.id, "Stopped responding", max.id);
  const mq = await basePrisma.quote.create({ data: { tenantId: A, number: quoteNo(), status: "sent", leadId: maxLead.id, contactId: max.id, createdById: repQuotes.id, createdAt: ago(20 * DAY), viewedAt: ago(2 * DAY) }, select: { number: true } });

  const lookup = async (tenantId: string, u: PermissionUser) =>
    (await runInTenantScope({ tenantId, system: false }, () => lostAliveLookup(u))).data[0] as Deals;
  const counts = async () => (await basePrisma.$queryRaw<{ n: number }[]>`
    SELECT ((SELECT count(*) FROM "Lead") + (SELECT count(*) FROM "Quote") + (SELECT count(*) FROM "Communication")
      + (SELECT count(*) FROM "SignatureView") + (SELECT count(*) FROM "AuditLog"))::int AS n`)[0].n;
  const deal = (r: Deals, leadId: string) => r.deals.find((d) => d.leadId === leadId);

  try {
    __setTenantEnforcingForTests(true);
    const before = await counts();

    console.log("\nlost_alive — a salesperson who may open the deal but not its quotes");
    const leadsOnly = await lookup(A, repLeads);
    check("the deal whose only sign of life is a quote view is not listed", !deal(leadsOnly, kimLead.id), JSON.stringify(leadsOnly.deals));
    check("…and its quote number appears nowhere in the answer", !JSON.stringify(leadsOnly).includes(String(kq.number)));
    check("the deal the customer messaged about is still listed", deal(leadsOnly, liaLead.id)?.since.some((s) => s.endsWith("sent a whatsapp message")) === true, JSON.stringify(leadsOnly.deals));

    console.log("\nlost_alive — a salesperson who may open their own quotes");
    const withQuotes = await lookup(A, repQuotes);
    check("their deal is listed with the quote they opened", deal(withQuotes, maxLead.id)?.since.some((s) => s.endsWith(`opened quote Q-${mq.number}`)) === true, JSON.stringify(withQuotes.deals));
    check("…and nothing of the other rep's deals", !deal(withQuotes, kimLead.id) && !deal(withQuotes, liaLead.id));

    console.log("\nlost_alive — the owner");
    const owner = await lookup(A, ownerA);
    check("the first deal is listed with its quote view", deal(owner, kimLead.id)?.since.some((s) => s.endsWith(`opened quote Q-${kq.number}`)) === true, JSON.stringify(owner.deals));

    console.log("\nlost_alive — the other workspace");
    const other = await lookup(b.tenantId, memberB);
    check("nothing of A's", !JSON.stringify(other).includes(`Lost${SFX}`) && !deal(other, kimLead.id) && !deal(other, maxLead.id));

    check("READ-ONLY: nothing was written", (await counts()) === before);
  } finally {
    __setTenantEnforcingForTests(null);
    const tenants = [A, b.tenantId];
    await basePrisma.signatureView.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => 0);
    await basePrisma.signatureRecipient.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => 0);
    await basePrisma.signatureRequest.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => 0);
    await basePrisma.communication.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "roleId" IN (${LEADS_ONLY}, ${WITH_QUOTES})`.catch(() => 0);
    await teardown(fixture);
    await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${repLeads.id}, ${repQuotes.id})`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "User" WHERE "id" IN (${repLeads.id}, ${repQuotes.id})`.catch(() => 0);
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
