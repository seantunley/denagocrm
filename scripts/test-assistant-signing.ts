/**
 * REAL-DATABASE proof of DAX's `signing` lookup (assistantSigningLookup.ts): every signing request, not only quotes
 * (Sean, 2026-11-14: "DAX must have knowledge of those things, permission based").
 *
 *   npm run test:assistant-signing     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * On the SCOPED client with enforcement on:
 *  - the owner sees every request: a quote's, a delivery note, a contract on a customer;
 *  - a rep with signing.view and their OWN quotes sees their quote's request and the delivery note for it — never the
 *    owner's quote's request, nor a delivery note for that quote (though the customer on it is the rep's);
 *  - someone without signing.view / signing.manage is refused; the other workspace sees nothing;
 *  - who signed, who opened and didn't, who wasn't reached — and NO token, email or phone anywhere in the output.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates.
 */
import crypto from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { signingLookup, type SigningArgs } from "../src/lib/assistantSigningLookup";
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
const ago = (days: number) => new Date(Date.now() - days * DAY);
const quoteNo = () => 100_000_000 + crypto.randomInt(800_000_000);
// Stored as a SHA-256 digest, as the database insists (never a raw capability).
const token = () => crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");

type Req = { title: string; for: string; status: string; signed: string[]; notSigned: string[]; openedNotSigned: string[]; lastReminder: string | null };
type Data = { total?: number; note?: string; requests?: Req[] };

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`sig${SFX}`);
  const { a, b } = fixture;
  const A = a.tenantId;
  const user = (name: string): PermissionUser => ({ id: crypto.randomUUID(), name, email: `${name.toLowerCase().replace(/\W/g, "")}.${SFX}@harness.invalid`, role: "member" });
  const rep = user("Sign Rep");
  const noSigning = user("No Signing");
  const ownerA: PermissionUser = { id: a.ownerUserId, name: "Harness A owner", email: "", role: "owner" };
  const memberB: PermissionUser = { id: b.memberUserId, name: "Harness B member", email: "", role: "member" };
  const REP_ROLE = crypto.randomUUID();
  const QUOTES_ONLY = crypto.randomUUID();

  for (const u of [rep, noSigning]) {
    await basePrisma.$executeRaw`INSERT INTO "User" ("id","name","email","passwordHash","role","sessionVersion") VALUES (${u.id}, ${u.name}, ${u.email}, 'x', 'member', 0)`;
    await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id","tenantId","userId") VALUES (${crypto.randomUUID()}, ${A}, ${u.id})`;
  }
  for (const [role, keys, holder] of [
    [REP_ROLE, ["signing.view", "quotes.view_owned", "contacts.view_owned"], rep],
    [QUOTES_ONLY, ["quotes.view_all", "contacts.view_all"], noSigning],
  ] as const) {
    await basePrisma.$executeRaw`INSERT INTO "Role" ("id","tenantId","name","description","system","updatedAt") VALUES (${role}, ${A}, ${`Signing ${role.slice(0, 8)} ${SFX}`}, 'test', false, now())`;
    for (const key of keys) await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId","permissionKey","tenantId") VALUES (${role}, ${key}, ${A})`;
    await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id","userId","roleId","tenantId") VALUES (${crypto.randomUUID()}, ${holder.id}, ${role}, ${A})`;
  }

  // The rep's customer and quote; the owner's customer and quote (a rep may open every quote on a customer they own, so
  // the owner's quote is on the owner's own customer).
  const marcel = await basePrisma.contact.create({ data: { tenantId: A, firstName: "Marcel", lastName: `Sign${SFX}`, ownerId: rep.id }, select: { id: true } });
  const petrus = await basePrisma.contact.create({ data: { tenantId: A, firstName: "Petrus", lastName: `Sign${SFX}`, ownerId: a.ownerUserId }, select: { id: true } });
  const repQuote = await basePrisma.quote.create({ data: { tenantId: A, number: quoteNo(), status: "sent", contactId: marcel.id, createdById: rep.id }, select: { id: true, number: true } });
  const ownerQuote = await basePrisma.quote.create({ data: { tenantId: A, number: quoteNo(), status: "sent", contactId: petrus.id, createdById: a.ownerUserId }, select: { id: true, number: true } });

  const request = async (title: string, data: Record<string, unknown>, recipients: { name: string; status: string; signedAt?: Date; viewedAt?: Date; remindedAt?: Date }[]) => {
    const r = await basePrisma.signatureRequest.create({ data: { tenantId: A, title: `${title} ${SFX}`, status: "sent", sentAt: ago(3), createdById: a.ownerUserId, ...data }, select: { id: true } });
    for (const [i, x] of recipients.entries()) {
      await basePrisma.signatureRecipient.create({ data: { tenantId: A, requestId: r.id, role: "signer", order: i, token: token(), email: `${x.name.toLowerCase()}.${SFX}@customer.invalid`, phone: "+27820000000", ...x } });
    }
    return r.id;
  };
  await request("Rep quote", { quoteId: repQuote.id, contactId: marcel.id }, [
    { name: "Marcel", status: "viewed", viewedAt: ago(1), remindedAt: ago(1) },
  ]);
  await request("Owner quote", { quoteId: ownerQuote.id, contactId: petrus.id }, [{ name: "Petrus", status: "sent" }]);
  await request("Delivery note rep", { subjectType: "delivery_note", subjectId: repQuote.id, contactId: marcel.id }, [{ name: "Marcel", status: "sent" }]);
  // On the page this one is governed by the customer — whom the rep may open — but it is about the OWNER's quote.
  await request("Delivery note owner", { subjectType: "delivery_note", subjectId: ownerQuote.id, contactId: marcel.id }, [{ name: "Marcel", status: "sent" }]);
  await request("Contract", { contactId: marcel.id, status: "completed", completedAt: ago(1) }, [
    { name: "Marcel", status: "signed", signedAt: ago(1) },
    { name: "Anna", status: "signed", signedAt: ago(2) },
  ]);

  const lookup = async (tenantId: string, u: PermissionUser, args: SigningArgs) =>
    (await runInTenantScope({ tenantId, system: false }, () => signingLookup(u, args))).data[0] as Data;
  const titles = (d: Data) => (d.requests ?? []).map((r) => r.title.replace(` ${SFX}`, "")).sort();

  try {
    __setTenantEnforcingForTests(true);

    console.log("\nThe owner");
    const all = await lookup(A, ownerA, { status: "any", title: SFX });
    check("sees every request — quotes, delivery notes, the contract", JSON.stringify(titles(all)) === JSON.stringify(["Contract", "Delivery note owner", "Delivery note rep", "Owner quote", "Rep quote"]), JSON.stringify(titles(all)));
    const waiting = await lookup(A, ownerA, { title: SFX });
    check("default is waiting: the four not yet signed, not the completed contract", waiting.total === 4 && !titles(waiting).includes("Contract"), JSON.stringify(titles(waiting)));
    const byCustomer = await lookup(A, ownerA, { status: "any", customer: `Petrus Sign${SFX}` });
    check("by customer: Petrus's quote request, and the delivery note for that quote", titles(byCustomer).join() === "Delivery note owner,Owner quote", JSON.stringify(titles(byCustomer)));
    const dn = (waiting.requests ?? []).find((r) => r.title.startsWith("Delivery note rep"));
    check("a delivery note says what it is for", dn?.for === `delivery note for Q-${repQuote.number}`, dn?.for);
    const viewed = await lookup(A, ownerA, { status: "viewed", title: SFX });
    const rq = viewed.requests?.[0];
    check("viewed: opened, not signed — with the last reminder", titles(viewed).join() === "Rep quote" && rq?.openedNotSigned.join() === "Marcel" && /opened .*not signed/.test(rq?.notSigned[0] ?? "") && rq?.lastReminder !== null, JSON.stringify(rq));
    const done = await lookup(A, ownerA, { status: "completed", title: `Contract ${SFX}` });
    check("completed: both signers named as signed", done.total === 1 && done.requests?.[0].signed.length === 2 && done.requests?.[0].notSigned.length === 0, JSON.stringify(done.requests));

    console.log("\nA rep with their own quotes");
    const repSees = await lookup(A, rep, { status: "any", title: SFX });
    check("sees their quote's request and the delivery note for it", titles(repSees).includes("Rep quote") && titles(repSees).includes("Delivery note rep"), JSON.stringify(titles(repSees)));
    check("never the owner's quote's request", !titles(repSees).includes("Owner quote"));
    check("never the delivery note for the owner's quote — though its customer is theirs", !titles(repSees).includes("Delivery note owner"));

    console.log("\nRefused, and the other workspace");
    const refused = await lookup(A, noSigning, { status: "any" });
    check("no signing permission: refused", /can't open signing requests/.test(refused.note ?? "") && !refused.requests, JSON.stringify(refused));
    const other = await lookup(b.tenantId, memberB, { status: "any" });
    check("the other workspace sees nothing of A's", !JSON.stringify(other).includes(SFX), JSON.stringify(other).slice(0, 200));

    console.log("\nNothing secret in the output");
    const tokens = await basePrisma.signatureRecipient.findMany({ where: { tenantId: A, request: { title: { endsWith: SFX } } }, select: { token: true } });
    const text = JSON.stringify(await runInTenantScope({ tenantId: A, system: false }, () => signingLookup(ownerA, { status: "any", title: SFX })));
    check("no signing token", tokens.every((t) => !text.includes(t.token)));
    check("no email address or phone number", !text.includes("@customer.invalid") && !text.includes("+2782"));
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.signatureRecipient.deleteMany({ where: { tenantId: A, request: { title: { endsWith: SFX } } } }).catch(() => 0);
    await basePrisma.signatureRequest.deleteMany({ where: { tenantId: A, title: { endsWith: SFX } } }).catch(() => 0);
    await basePrisma.quote.deleteMany({ where: { id: { in: [repQuote.id, ownerQuote.id] } } }).catch(() => 0);
    await basePrisma.contact.deleteMany({ where: { id: { in: [marcel.id, petrus.id] } } }).catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "roleId" IN (${REP_ROLE}, ${QUOTES_ONLY})`.catch(() => 0);
    await teardown(fixture);
    await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${rep.id}, ${noSigning.id})`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "User" WHERE "id" IN (${rep.id}, ${noSigning.id})`.catch(() => 0);
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
