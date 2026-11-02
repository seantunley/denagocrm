/**
 * PROOF OF PAYMENT MATCHED TO ITS QUOTE, on a real database (round 2, item 3 — Sean, 2026-11-02).
 *
 *   npm run test:assistant-payment-match     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * Through the SCOPED client with enforcement on, as constrained users: match_payment finds the exact deposit, the
 * balance owing and a reference; two quotes owing the same amount are both offered with no single pick; another
 * rep's quote never matches; a role without deliveries.manage gets nothing; another workspace never matches, not
 * even for a manager who sees every quote. A clear match makes the ordinary record_payment card. Read-only: nothing
 * is recorded. The model is never called; nobody is contacted. Removes every row it creates.
 */
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import type { PermissionUser } from "../src/lib/permissions";
import type { ActionCard } from "../src/lib/assistantActions";
import { resolveActions } from "../src/lib/crmAssistant";
import { matchPayment } from "../src/lib/assistantPaymentMatch";
import { signFreshSession } from "../src/lib/session";
import { runAsSession, type ActingSession } from "./harness/actingSession";

const SFX = Math.random().toString(16).slice(2, 10);
const LETTERS = Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

function guardEnvironment() {
  const url = process.env.DATABASE_URL ?? "";
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
}

const id = (what: string) => `asst-pay-${what}-${SFX}`;
const T = DEFAULT_TENANT_ID;
const user = (what: string): PermissionUser => ({ id: id(what), name: what, email: `${id(what)}@example.invalid`, role: "member" });
const rep = user("rep");
const other = user("other");
const limited = user("limited"); // a sales rep's role without deliveries.manage
const manager = user("manager"); // a CRM admin: sees every quote in the workspace
const USERS = [rep, other, limited, manager];
const ROLE = id("role");
const OTHER_TENANT = id("tenant");
const BASE = 700_000 + Math.floor(Math.random() * 200_000) * 5; // quote numbers are unique across workspaces
const N = { A: BASE, B: BASE + 1, C: BASE + 2, D: BASE + 3, E: BASE + 4 };
const NX = BASE - 1;
const ANNA = `Annafield${LETTERS}`;
const scoped = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: T, system: false }, fn);

type QuoteSeed = { key: string; number: number; tenantId?: string; contactId?: string; createdById: string; totalCents: number; depositRands?: number; depositPaidCents?: number };
async function quote(q: QuoteSeed) {
  const tenantId = q.tenantId ?? T;
  await basePrisma.quote.create({
    data: {
      id: id(q.key), number: q.number, tenantId, status: "accepted", invoiceNumber: q.number, invoicedAt: new Date(),
      contactId: q.contactId ?? null, createdById: q.createdById,
      ...(q.depositRands ? { depositType: "amount", depositValue: q.depositRands } : {}),
      ...(q.depositPaidCents ? { depositPaidAt: new Date(), depositPaidCents: q.depositPaidCents } : {}),
      items: { create: [{ tenantId, description: "Rover XL", qty: 1, unitPriceCents: q.totalCents, taxRatePct: 15 }] },
    },
  });
}
const QUOTES = ["A", "B", "C", "D", "E", "X"];

async function seed() {
  await basePrisma.tenant.create({ data: { id: OTHER_TENANT, name: `Payment match test ${SFX}`, slug: `pay-match-${SFX}` } });
  await basePrisma.user.createMany({ data: USERS.map((u) => ({ id: u.id, name: u.name, email: u.email, passwordHash: "test", role: "member", modules: "crm" })) });
  await basePrisma.role.create({ data: { id: ROLE, tenantId: T, name: `No payments ${SFX}` } });
  await basePrisma.$executeRaw`
    INSERT INTO "RolePermission" ("roleId", "permissionKey", "tenantId")
    SELECT ${ROLE}, "permissionKey", ${T} FROM "RolePermission" WHERE "roleId" = 'role_sales_rep' AND "tenantId" = ${T} AND "permissionKey" <> 'deliveries.manage'`;
  await basePrisma.$executeRaw`
    INSERT INTO "UserRole" ("id", "userId", "roleId", "tenantId") VALUES
      (gen_random_uuid()::text, ${rep.id}, 'role_sales_rep', ${T}),
      (gen_random_uuid()::text, ${other.id}, 'role_sales_rep', ${T}),
      (gen_random_uuid()::text, ${limited.id}, ${ROLE}, ${T}),
      (gen_random_uuid()::text, ${manager.id}, 'role_crm_admin', ${T})`;
  await basePrisma.$executeRaw`
    INSERT INTO "TenantMember" ("id", "tenantId", "userId") VALUES
      (${id("tm-rep")}, ${T}, ${rep.id}), (${id("tm-other")}, ${T}, ${other.id}), (${id("tm-limited")}, ${T}, ${limited.id}), (${id("tm-manager")}, ${T}, ${manager.id})`;
  await basePrisma.contact.create({ data: { id: id("c-anna"), tenantId: T, firstName: "Anna", lastName: ANNA, ownerId: rep.id, createdById: rep.id } });
  await basePrisma.contact.create({ data: { id: id("c-ben"), tenantId: T, firstName: "Ben", lastName: `Botha${SFX}`, ownerId: rep.id, createdById: rep.id } });
  await basePrisma.contact.create({ data: { id: id("c-carl"), tenantId: T, firstName: "Carl", lastName: `Other${SFX}`, ownerId: other.id, createdById: other.id } });
  // A: Anna's, R100 000, deposit R25 123 due. B: Ben's, R80 000, R20 000 deposit in → R60 000 owing.
  await quote({ key: "A", number: N.A, contactId: id("c-anna"), createdById: rep.id, totalCents: 10_000_000, depositRands: 25_123 });
  await quote({ key: "B", number: N.B, contactId: id("c-ben"), createdById: rep.id, totalCents: 8_000_000, depositPaidCents: 2_000_000 });
  // C: the OTHER rep's customer, R31 234 deposit due.
  await quote({ key: "C", number: N.C, contactId: id("c-carl"), createdById: other.id, totalCents: 9_000_000, depositRands: 31_234 });
  // D and E both want R33 333: D's deposit, E's whole balance.
  await quote({ key: "D", number: N.D, contactId: id("c-ben"), createdById: rep.id, totalCents: 10_000_000, depositRands: 33_333 });
  await quote({ key: "E", number: N.E, contactId: id("c-anna"), createdById: rep.id, totalCents: 3_333_300 });
  // X: ANOTHER WORKSPACE, created by the rep himself, R41 111 deposit due.
  await quote({ key: "X", number: NX, tenantId: OTHER_TENANT, createdById: rep.id, totalCents: 10_000_000, depositRands: 41_111 });
}

async function cleanup() {
  const ids = USERS.map((u) => u.id);
  const quoteIds = QUOTES.map(id);
  await basePrisma.quoteItem.deleteMany({ where: { quoteId: { in: quoteIds } } });
  await basePrisma.quote.deleteMany({ where: { id: { in: quoteIds } } });
  await basePrisma.contact.deleteMany({ where: { id: { in: [id("c-anna"), id("c-ben"), id("c-carl")] } } });
  await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${rep.id}, ${other.id}, ${limited.id}, ${manager.id})`;
  await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "userId" IN (${rep.id}, ${other.id}, ${limited.id}, ${manager.id})`;
  await basePrisma.$executeRaw`DELETE FROM "RolePermission" WHERE "roleId" = ${ROLE} AND "tenantId" = ${T}`;
  await basePrisma.role.deleteMany({ where: { id: ROLE } });
  await basePrisma.user.deleteMany({ where: { id: { in: ids } } });
  await basePrisma.tenant.deleteMany({ where: { id: OTHER_TENANT } });
}

const sessions = new Map<string, ActingSession>();
async function sessionFor(u: PermissionUser): Promise<ActingSession> {
  if (!sessions.has(u.id)) sessions.set(u.id, { cookieValue: await signFreshSession({ id: u.id, name: u.name ?? "", email: u.email ?? "", role: u.role, grants: "", sessionVersion: 0 }, 60, { tid: T }), label: u.name ?? u.id });
  return sessions.get(u.id)!;
}
type Head = { verdict: string };
type Row = { quote: string; why: string[]; customer: string };
async function match(u: PermissionUser, args: { amount: number; reference?: string; payer?: string; paidOn?: string }) {
  const out = await runAsSession(await sessionFor(u), () => scoped(() => matchPayment(u, args)));
  const [head, ...rows] = out.data as [Head, ...Row[]];
  return { head, rows, quotes: rows.map((r) => r.quote), out };
}
const q = (n: number) => `Q-${n}`;
// Only this run's quotes (a reused test database may hold others).
const mine = (quotes: string[]) => quotes.filter((x) => [...Object.values(N), NX].map(q).includes(x));

async function main() {
  guardEnvironment();
  __setTenantEnforcingForTests(true);
  await seed();

  console.log("\nMatching");
  const deposit = await match(rep, { amount: 25_123, paidOn: "2026-11-02" });
  check("the exact deposit due: one clear match, and why", deposit.head.verdict.startsWith(`ONE CLEAR MATCH: ${q(N.A)}`) && deposit.rows[0]?.why.length === 1 && /deposit due/.test(deposit.rows[0].why[0]) && deposit.rows[0]?.customer === `Anna ${ANNA}`, JSON.stringify(deposit.out));
  const balance = await match(rep, { amount: 60_000 });
  check("the balance owing (after the deposit recorded): one clear match", balance.head.verdict.startsWith(`ONE CLEAR MATCH: ${q(N.B)}`) && /balance owing/.test(balance.rows[0]?.why.join() ?? ""), JSON.stringify(balance.out));
  const reference = await match(rep, { amount: 1_000, reference: `INV-${String(N.B).padStart(6, "0")} BEN` });
  check("the bank reference names the invoice: one clear match", reference.head.verdict.startsWith(`ONE CLEAR MATCH: ${q(N.B)}`) && /reference/.test(reference.rows[0]?.why.join() ?? ""), JSON.stringify(reference.out));
  const same = await match(rep, { amount: 33_333 });
  check("two quotes wanting the same amount: both offered, no single pick", /^SEVERAL/.test(same.head.verdict) && mine(same.quotes).sort().join() === [q(N.D), q(N.E)].sort().join(), JSON.stringify(same.out));
  const payer = await match(rep, { amount: 33_333, payer: `MRS A ${ANNA.toUpperCase()}` });
  check("…the payer's name on the slip settles it (E is Anna's)", payer.head.verdict.startsWith(`ONE CLEAR MATCH: ${q(N.E)}`), JSON.stringify(payer.out));
  const none = await match(rep, { amount: 12_345.67 });
  check("nothing fits: no match, ask which quote", /^NO MATCH/.test(none.head.verdict) && mine(none.quotes).length === 0, JSON.stringify(none.out));

  console.log("\nWho may see what");
  const othersQuote = await match(rep, { amount: 31_234, reference: q(N.C) });
  check("another rep's quote never matches (not by amount, not by its own number)", !mine(othersQuote.quotes).includes(q(N.C)), JSON.stringify(othersQuote.out));
  const theirs = await match(other, { amount: 31_234 });
  check("…while that rep gets it as the clear match", theirs.head.verdict.startsWith(`ONE CLEAR MATCH: ${q(N.C)}`), JSON.stringify(theirs.out));
  const noRole = await match(limited, { amount: 25_123 });
  check("a role without deliveries.manage gets nothing", noRole.rows.length === 0 && noRole.out.rows.length === 0 && /can't record payments/.test(JSON.stringify(noRole.out.data)), JSON.stringify(noRole.out));
  const otherWorkspace = await match(rep, { amount: 41_111, reference: q(NX) });
  check("another workspace never matches — even a quote the rep created there", !otherWorkspace.quotes.includes(q(NX)), JSON.stringify(otherWorkspace.out));
  const managerSees = await match(manager, { amount: 41_111, reference: q(NX) });
  check("…nor for a manager who sees every quote", !managerSees.quotes.includes(q(NX)), JSON.stringify(managerSees.out));
  const managerAll = await match(manager, { amount: 31_234 });
  check("…though the manager does match across reps in this workspace", managerAll.head.verdict.startsWith(`ONE CLEAR MATCH: ${q(N.C)}`), JSON.stringify(managerAll.out));

  console.log("\nThe card");
  {
    const problems: string[] = [];
    const upload = { id: id("upload"), fileName: "pop.pdf", mimeType: "application/pdf", image: null, sentAt: new Date() };
    const cards = await runAsSession(await sessionFor(rep), () => scoped(() =>
      resolveActions(rep, [{ type: "record_payment", quote: q(N.A), amount: 25_123, method: "eft", receivedOn: "2026-11-02", reference: "ANNA DEP" } as never], problems, null, upload)));
    const card = cards.find((c): c is Extract<ActionCard, { kind: "record_payment" }> => c.kind === "record_payment");
    check("the clear match makes the ordinary record_payment card, every figure on it", card?.quoteId === id("A") && card.amountCents === 2_512_300 && /ref ANNA DEP/.test(card.detail), JSON.stringify({ cards, problems }));
    const recorded = await basePrisma.quotePayment.count({ where: { quoteId: { in: QUOTES.map(id) } } });
    const depositIn = await basePrisma.quote.count({ where: { id: id("A"), depositPaidAt: { not: null } } });
    check("nothing recorded without Confirm", recorded === 0 && depositIn === 0);
  }
}

main()
  .catch((error) => { failed++; console.error("\nUNEXPECTED ERROR", error); })
  .finally(async () => {
    __setTenantEnforcingForTests(null);
    await cleanup().catch((error) => { failed++; console.error("cleanup failed", error); });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
