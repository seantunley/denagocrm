/**
 * EACH WORKSPACE'S OWN INTEGRATION DETAILS, on a real database (Sean, 2026-11-27:
 * "tenant fourbuy has no access to setup chatgpt and whatsapp etc… each workspace
 * has to have their own details").
 *
 *   npm run test:workspace-integrations   (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * Drives the REAL server actions as each workspace's owner, with tenant
 * enforcement on (as production runs):
 *  - a second workspace's owner makes an API key; it authenticates the public
 *    intake as THAT workspace, is stored only as a hash, and another workspace's
 *    owner can neither revoke it nor see it; revoked, it is refused at once;
 *  - a member who is not the workspace's owner cannot make one;
 *  - an AI key saved by one workspace's owner is that workspace's alone: not the
 *    founding workspace's, not readable or revealable by another workspace, and it
 *    is the key that workspace's AI uses.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * every row it creates (AuditEvent is append-only and is left, as everywhere).
 */
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { signFreshSession } from "../src/lib/session";
import { authenticateIntakeKey, hashApiKey } from "../src/lib/apiKeys";
import { getProviderKey } from "../src/lib/settings";
import { createApiKey, revokeApiKey } from "../src/app/actions/apiKeys";
import { revealSecret, saveSetting } from "../src/app/actions/settings";
import { runAsSession, type ActingSession } from "./harness/actingSession";

const SFX = Math.random().toString(16).slice(2, 10);
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

const id = (what: string) => `wsint-${what}-${SFX}`;
const A = id("tenant-a"); // "fourbuy"
const B = id("tenant-b"); // any other workspace
type Person = { id: string; name: string; email: string };
const ownerA: Person = { id: id("owner-a"), name: "Owner A", email: `${id("owner-a")}@example.invalid` };
const memberA: Person = { id: id("member-a"), name: "Member A", email: `${id("member-a")}@example.invalid` };
const ownerB: Person = { id: id("owner-b"), name: "Owner B", email: `${id("owner-b")}@example.invalid` };
const PEOPLE = [ownerA, memberA, ownerB];
const tenantOf = new Map([[ownerA.id, A], [memberA.id, A], [ownerB.id, B]]);

async function sessionFor(person: Person): Promise<ActingSession> {
  const tid = tenantOf.get(person.id)!;
  return {
    cookieValue: await signFreshSession({ id: person.id, name: person.name, email: person.email, role: "member", grants: "", sessionVersion: 0 }, 60, { tid }),
    label: person.name,
  };
}
const as = async <R>(person: Person, fn: () => Promise<R>) =>
  runAsSession(await sessionFor(person), () => runInTenantScope({ tenantId: tenantOf.get(person.id)!, system: false }, fn));
// A refused auth gate redirects, which the harness surfaces as a throw.
const attempt = async <R>(fn: () => Promise<R>): Promise<R | { thrown: string }> => fn().catch((error: Error) => ({ thrown: error.message }));
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

async function seed() {
  await basePrisma.tenant.createMany({
    data: [
      { id: A, name: `Fourbuy test ${SFX}`, slug: `wsint-a-${SFX}`, active: true },
      { id: B, name: `Other test ${SFX}`, slug: `wsint-b-${SFX}`, active: true },
    ],
  });
  await basePrisma.user.createMany({
    data: PEOPLE.map((person) => ({ id: person.id, name: person.name, email: person.email, passwordHash: "test", role: "member", modules: "crm" })),
  });
  await basePrisma.tenant.update({ where: { id: A }, data: { ownerUserId: ownerA.id } });
  await basePrisma.tenant.update({ where: { id: B }, data: { ownerUserId: ownerB.id } });
  await basePrisma.$executeRaw`
    INSERT INTO "TenantMember" ("id", "tenantId", "userId") VALUES
      (${id("tm-oa")}, ${A}, ${ownerA.id}), (${id("tm-ma")}, ${A}, ${memberA.id}), (${id("tm-ob")}, ${B}, ${ownerB.id})`;
}

async function cleanup() {
  await basePrisma.$executeRaw`DELETE FROM "TenantApiKey" WHERE "tenantId" IN (${A}, ${B})`;
  await basePrisma.appSetting.deleteMany({ where: { tenantId: { in: [A, B] } } });
  await basePrisma.auditLog.deleteMany({ where: { userId: { in: PEOPLE.map((person) => person.id) } } });
  await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "tenantId" IN (${A}, ${B})`;
  await basePrisma.tenant.updateMany({ where: { id: { in: [A, B] } }, data: { ownerUserId: null } });
  await basePrisma.user.deleteMany({ where: { id: { in: PEOPLE.map((person) => person.id) } } });
  await basePrisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
}

async function main() {
  guardEnvironment();
  __setTenantEnforcingForTests(true);
  await seed();

  console.log("\nA workspace's own website key");
  {
    const made = await as(ownerA, () => createApiKey("Website"));
    const rawKey = "rawKey" in made ? made.rawKey : "";
    check("the workspace's owner makes a key, shown once", Boolean(rawKey) && rawKey.startsWith("dcrm_"), JSON.stringify(made));
    const stored = await basePrisma.$queryRaw<{ id: string; tenantId: string; hashedKey: string; label: string }[]>`
      SELECT "id", "tenantId", "hashedKey", "label" FROM "TenantApiKey" WHERE "tenantId" = ${A}`;
    check("…stored for THAT workspace, as a hash only", stored.length === 1 && stored[0].hashedKey === hashApiKey(rawKey) && stored[0].label === "Website");
    check("…and nowhere as the raw key", (await basePrisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "TenantApiKey" WHERE "hashedKey" = ${rawKey} OR "prefix" = ${rawKey}`)[0].n === 0);
    const auth = await authenticateIntakeKey(rawKey, "intake");
    check("the website's lead lands in that workspace", auth?.tenantId === A, JSON.stringify(auth));
    check("…and the key works for bookings and the service lookup too", (await authenticateIntakeKey(rawKey, "bookings"))?.tenantId === A && (await authenticateIntakeKey(rawKey, "service-lookup"))?.tenantId === A);

    const theirs = await attempt(() => as(ownerB, () => revokeApiKey(stored[0].id)));
    check("another workspace's owner cannot revoke it", "error" in (theirs as object) && (await authenticateIntakeKey(rawKey, "intake"))?.tenantId === A, JSON.stringify(theirs));
    const memberTry = await attempt(() => as(memberA, () => createApiKey("Sneaky")));
    check("a member who is not the owner cannot make one", "thrown" in (memberTry as object) || "error" in (memberTry as object), JSON.stringify(memberTry));
    check("…and none was made", (await basePrisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "TenantApiKey" WHERE "tenantId" = ${A}`)[0].n === 1);

    const revoked = await as(ownerA, () => revokeApiKey(stored[0].id));
    check("the owner revokes it", "success" in revoked, JSON.stringify(revoked));
    check("…and it is refused at once", (await authenticateIntakeKey(rawKey, "intake")) === null);
    const again = await as(ownerA, () => revokeApiKey(stored[0].id));
    check("…only once", "error" in again);
  }

  console.log("\nA workspace's own AI key");
  {
    const founding = await basePrisma.appSetting.findUnique({ where: { tenantId_key: { tenantId: DEFAULT_TENANT_ID, key: "ANTHROPIC_API_KEY" } } });
    const saved = await as(ownerA, () => saveSetting(form({ key: "ANTHROPIC_API_KEY", value: "sk-ant-fourbuy-own" })));
    check("the workspace's owner saves their own Claude key", !("error" in (saved ?? {})), JSON.stringify(saved));
    const row = await basePrisma.appSetting.findUnique({ where: { tenantId_key: { tenantId: A, key: "ANTHROPIC_API_KEY" } } });
    check("…stored under THAT workspace (encrypted)", Boolean(row?.value) && row?.value !== "sk-ant-fourbuy-own");
    const foundingAfter = await basePrisma.appSetting.findUnique({ where: { tenantId_key: { tenantId: DEFAULT_TENANT_ID, key: "ANTHROPIC_API_KEY" } } });
    check("…the founding workspace's own key is untouched", (foundingAfter?.value ?? null) === (founding?.value ?? null));
    check("that workspace's AI uses its own key", (await as(ownerA, () => getProviderKey("ANTHROPIC_API_KEY"))) === "sk-ant-fourbuy-own");
    check("another workspace's AI does not get it", (await as(ownerB, () => getProviderKey("ANTHROPIC_API_KEY"))) !== "sk-ant-fourbuy-own");
    const revealed = await attempt(() => as(ownerB, () => revealSecret("ANTHROPIC_API_KEY")));
    check("another workspace's owner cannot reveal it", revealed !== "sk-ant-fourbuy-own", JSON.stringify(revealed));
    check("…but its own owner can", (await as(ownerA, () => revealSecret("ANTHROPIC_API_KEY"))) === "sk-ant-fourbuy-own");
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
