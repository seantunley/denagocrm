/**
 * EACH WORKSPACE'S OWN INTEGRATION DETAILS, on a real database (Sean, 2026-11-27:
 * "tenant fourbuy has no access to setup chatgpt and whatsapp etc… each workspace
 * has to have their own details"; review of #1240).
 *
 *   npm run test:workspace-integrations   (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * Drives the REAL server actions and the REAL public intake route as each
 * workspace's owner, with tenant enforcement on (as production runs). OpenAI,
 * Telegram and Meta are answered by a stand-in `fetch`; any other network call
 * fails the run.
 *
 *  - Website keys: a second workspace's owner makes a key that does exactly what
 *    was ticked — an intake-only key is refused for bookings and the service
 *    lookup; it is stored as a hash; another owner cannot revoke it, a member
 *    cannot make one; a lead POSTed to /api/intake lands in that workspace;
 *    revoked, the route refuses it.
 *  - Plan-supplied AI: entitlement without a platform key supplies nothing; with
 *    one it does; the workspace's own key always wins and is its alone.
 *  - ChatGPT sign-in, Telegram and WhatsApp: connected by one workspace's owner,
 *    stored and routed for that workspace only; another workspace neither sees
 *    nor disconnects them; the founding workspace's own are untouched.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database; removes every
 * row it creates and restores the founding workspace's settings it touches.
 */
import { NextRequest } from "next/server";
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { signFreshSession } from "../src/lib/session";
import { authenticateIntakeKey, hashApiKey } from "../src/lib/apiKeys";
import { getProviderKey, getWorkspaceSetting, providerKeySupplied, putWorkspaceSetting, resolveIntegrationBundle } from "../src/lib/settings";
import { isCodexConnected } from "../src/lib/codex";
import { resolveTelegramTenant } from "../src/lib/telegramTenant";
import { resolveChannelTenant } from "../src/lib/channelTenant";
import { createApiKey, revokeApiKey } from "../src/app/actions/apiKeys";
import { revealSecret, saveSetting } from "../src/app/actions/settings";
import { disconnectChatGpt, pollChatGptLogin, startChatGptLogin } from "../src/app/actions/codex";
import { connectTelegram, disconnectTelegram, telegramStatus } from "../src/app/actions/bot";
import { saveTenantCredentialOverride } from "../src/app/actions/tenantCredentials";
import { POST as intakePost } from "../src/app/api/intake/route";
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

// ── The outside world, answered ────────────────────────────────────────────
const realFetch = globalThis.fetch;
let networkCalls = 0;
function standInFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    networkCalls++;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") return json({ device_auth_id: `dev-${networkCalls}`, user_code: `CODE-${networkCalls}`, interval: 1 });
    if (url === "https://auth.openai.com/api/accounts/deviceauth/token") return json({ authorization_code: "auth-code", code_verifier: "code-verifier" });
    if (url === "https://auth.openai.com/oauth/token") return json({ access_token: `access-${networkCalls}`, refresh_token: `refresh-${networkCalls}`, expires_in: 3600 });
    if (url === "https://auth.openai.com/oauth/revoke") return json({});
    if (url.startsWith("https://api.telegram.org/bot")) return json({ ok: true, result: true });
    if (url.startsWith("https://graph.facebook.com/")) return json({ data: [] });
    void init;
    throw new Error(`unexpected network call in a test: ${url}`);
  }) as typeof fetch;
}

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
const refused = (value: unknown) => Boolean(value && typeof value === "object" && ("thrown" in value || "error" in value));
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const setting = (tenantId: string, key: string) => basePrisma.appSetting.findUnique({ where: { tenantId_key: { tenantId, key } } });

// The founding workspace's settings this run touches, as they were — put back at the end.
const FOUNDING_KEYS = ["ANTHROPIC_API_KEY", "CODEX_OAUTH_TOKENS", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"];
const foundingBefore = new Map<string, string | null>();

async function seed() {
  for (const key of FOUNDING_KEYS) foundingBefore.set(key, (await setting(DEFAULT_TENANT_ID, key))?.value ?? null);
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
  // The sales pipeline the workspace's owner sets up (Settings → Pipelines) — where a website lead is filed.
  await basePrisma.salesPipeline.create({ data: { id: id("pipeline-a"), tenantId: A, name: "Sales", isDefault: true } });
  await basePrisma.pipelineStage.create({ data: { id: id("stage-a"), tenantId: A, name: "New enquiry", order: 1, pipelineId: id("pipeline-a") } });
}

/** Every row either test workspace owns, in any table — then the workspaces and people themselves. */
async function cleanup() {
  const tables = await basePrisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenantId' AND table_name <> 'Tenant'`;
  for (let pass = 0; pass < 5; pass++) {
    let blocked = 0;
    for (const { table_name } of tables) {
      // Append-only trails refuse deletes by design; they are left, as in every database test.
      await basePrisma.$executeRawUnsafe(`DELETE FROM "${table_name}" WHERE "tenantId" IN ($1, $2)`, A, B).catch(() => { blocked++; });
    }
    if (!blocked) break;
  }
  await basePrisma.tenant.updateMany({ where: { id: { in: [A, B] } }, data: { ownerUserId: null } });
  await basePrisma.auditLog.deleteMany({ where: { userId: { in: PEOPLE.map((person) => person.id) } } });
  await basePrisma.user.deleteMany({ where: { id: { in: PEOPLE.map((person) => person.id) } } });
  await basePrisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
  for (const [key, value] of foundingBefore) {
    if (value === null) await basePrisma.appSetting.deleteMany({ where: { tenantId: DEFAULT_TENANT_ID, key } });
    else await basePrisma.appSetting.upsert({ where: { tenantId_key: { tenantId: DEFAULT_TENANT_ID, key } }, update: { value }, create: { tenantId: DEFAULT_TENANT_ID, key, value } });
  }
}

async function main() {
  guardEnvironment();
  __setTenantEnforcingForTests(true);
  standInFetch();
  await seed();

  console.log("\nA workspace's own website keys — and only what each is for");
  let intakeKey = "";
  let intakeKeyId = "";
  {
    const made = await as(ownerA, () => createApiKey("Website", ["intake"]));
    intakeKey = "rawKey" in made ? made.rawKey : "";
    check("the workspace's owner makes an intake key, shown once", intakeKey.startsWith("dcrm_"), JSON.stringify(made));
    const stored = await basePrisma.$queryRaw<{ id: string; hashedKey: string; scopes: string }[]>`
      SELECT "id", "hashedKey", "scopes" FROM "TenantApiKey" WHERE "tenantId" = ${A}`;
    intakeKeyId = stored[0]?.id ?? "";
    check("…stored for THAT workspace, as a hash, for intake only", stored.length === 1 && stored[0].hashedKey === hashApiKey(intakeKey) && stored[0].scopes === "intake", JSON.stringify(stored));
    check("…accepted for website leads, as that workspace", (await authenticateIntakeKey(intakeKey, "intake"))?.tenantId === A);
    check("…refused for bookings and the service lookup", (await authenticateIntakeKey(intakeKey, "bookings")) === null && (await authenticateIntakeKey(intakeKey, "service-lookup")) === null);
    const booking = await as(ownerA, () => createApiKey("Booking widget", ["bookings"]));
    const bookingKey = "rawKey" in booking ? booking.rawKey : "";
    check("a bookings key books, and sends no leads", (await authenticateIntakeKey(bookingKey, "bookings"))?.tenantId === A && (await authenticateIntakeKey(bookingKey, "intake")) === null);
    check("a key for nothing, or for something that isn't a scope, is refused",
      refused(await as(ownerA, () => createApiKey("Empty", []))) && refused(await as(ownerA, () => createApiKey("Admin", ["intake", "admin"]))));

    const theirs = await attempt(() => as(ownerB, () => revokeApiKey(intakeKeyId)));
    check("another workspace's owner cannot revoke it", refused(theirs) && (await authenticateIntakeKey(intakeKey, "intake"))?.tenantId === A, JSON.stringify(theirs));
    const memberTry = await attempt(() => as(memberA, () => createApiKey("Sneaky", ["intake"])));
    check("a member who is not the owner cannot make one", refused(memberTry), JSON.stringify(memberTry));
    check("…and none was made", (await basePrisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "TenantApiKey" WHERE "tenantId" = ${A}`)[0].n === 2);
  }

  console.log("\nA lead POSTed to the public intake lands in the key's workspace");
  {
    const post = (key: string, name: string) =>
      intakePost(new NextRequest("https://crm.example.test/api/intake", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "x-forwarded-for": "203.0.113.7" },
        body: JSON.stringify({ name, email: `${SFX}@example.invalid`, message: "Interested in a cart", source: "website" }),
      }));
    const name = `Website Lead ${SFX}`;
    const response = await post(intakeKey, name);
    const lead = await basePrisma.lead.findFirst({ where: { title: { contains: SFX } }, select: { tenantId: true } })
      ?? await basePrisma.lead.findFirst({ where: { name }, select: { tenantId: true } });
    check("the website's lead is accepted", response.status < 300, `${response.status} ${await response.clone().text()}`);
    check("…and filed in that workspace", lead?.tenantId === A, JSON.stringify(lead));
    check("an unknown key is refused", (await post("dcrm_not-a-real-key", `Nope ${SFX}`)).status === 401);
    const revoked = await as(ownerA, () => revokeApiKey(intakeKeyId));
    check("the owner revokes the key", "success" in revoked, JSON.stringify(revoked));
    check("…and the intake refuses it at once", (await post(intakeKey, `After revoke ${SFX}`)).status === 401);
    check("…only once", "error" in (await as(ownerA, () => revokeApiKey(intakeKeyId))));
  }

  console.log("\nAI the platform supplies — only when there is a key to supply");
  {
    await basePrisma.appSetting.deleteMany({ where: { tenantId: DEFAULT_TENANT_ID, key: "ANTHROPIC_API_KEY" } });
    check("not on the plan: nothing supplied", !(await as(ownerA, () => providerKeySupplied("ANTHROPIC_API_KEY"))));
    await basePrisma.tenant.update({ where: { id: A }, data: { platformAi: true } });
    check("on the plan, but the platform has no key saved: nothing supplied", !(await as(ownerA, () => providerKeySupplied("ANTHROPIC_API_KEY"))));
    check("…and the AI has no key", (await as(ownerA, () => getProviderKey("ANTHROPIC_API_KEY"))) === null);
    await putWorkspaceSetting(DEFAULT_TENANT_ID, "ANTHROPIC_API_KEY", "sk-ant-platform-test");
    check("on the plan, with a platform key: supplied", await as(ownerA, () => providerKeySupplied("ANTHROPIC_API_KEY")));
    check("…and that is the key the AI uses", (await as(ownerA, () => getProviderKey("ANTHROPIC_API_KEY"))) === "sk-ant-platform-test");
    check("a workspace not on the plan is not supplied", !(await as(ownerB, () => providerKeySupplied("ANTHROPIC_API_KEY"))) && (await as(ownerB, () => getProviderKey("ANTHROPIC_API_KEY"))) === null);
  }

  console.log("\nA workspace's own AI key");
  {
    const saved = await as(ownerA, () => saveSetting(form({ key: "ANTHROPIC_API_KEY", value: "sk-ant-fourbuy-own" })));
    check("the workspace's owner saves their own Claude key", !("error" in (saved ?? {})), JSON.stringify(saved));
    const row = await setting(A, "ANTHROPIC_API_KEY");
    check("…stored under THAT workspace (encrypted)", Boolean(row?.value) && row?.value !== "sk-ant-fourbuy-own");
    check("…the founding workspace's key is untouched", (await getWorkspaceSetting(DEFAULT_TENANT_ID, "ANTHROPIC_API_KEY")) === "sk-ant-platform-test");
    check("its own key wins over the plan's, and is no longer 'supplied'", (await as(ownerA, () => getProviderKey("ANTHROPIC_API_KEY"))) === "sk-ant-fourbuy-own" && !(await as(ownerA, () => providerKeySupplied("ANTHROPIC_API_KEY"))));
    check("another workspace's AI does not get it", (await as(ownerB, () => getProviderKey("ANTHROPIC_API_KEY"))) !== "sk-ant-fourbuy-own");
    const revealed = await attempt(() => as(ownerB, () => revealSecret("ANTHROPIC_API_KEY")));
    check("another workspace's owner cannot reveal it", revealed !== "sk-ant-fourbuy-own", JSON.stringify(revealed));
    check("…but its own owner can", (await as(ownerA, () => revealSecret("ANTHROPIC_API_KEY"))) === "sk-ant-fourbuy-own");
  }

  console.log("\nA workspace's own ChatGPT sign-in");
  {
    const foundingTokens = (await setting(DEFAULT_TENANT_ID, "CODEX_OAUTH_TOKENS"))?.value ?? null;
    const started = await as(ownerA, () => startChatGptLogin());
    const userCode = "userCode" in started ? started.userCode : "";
    check("the workspace's owner starts the sign-in", Boolean(userCode), JSON.stringify(started));
    const polled = await as(ownerA, () => pollChatGptLogin(userCode));
    check("…and completes it", "state" in polled && polled.state === "connected", JSON.stringify(polled));
    check("…stored under THAT workspace", Boolean((await setting(A, "CODEX_OAUTH_TOKENS"))?.value));
    check("that workspace's AI is connected to ChatGPT", await as(ownerA, () => isCodexConnected()));
    check("another workspace's is not", !(await as(ownerB, () => isCodexConnected())));
    check("the founding workspace's sign-in is untouched", ((await setting(DEFAULT_TENANT_ID, "CODEX_OAUTH_TOKENS"))?.value ?? null) === foundingTokens);
    await as(ownerB, () => disconnectChatGpt());
    check("another workspace's Disconnect leaves it connected", await as(ownerA, () => isCodexConnected()));
    await as(ownerA, () => disconnectChatGpt());
    check("its own owner disconnects it", !(await as(ownerA, () => isCodexConnected())));
  }

  console.log("\nA workspace's own Telegram bot");
  {
    const foundingToken = (await setting(DEFAULT_TENANT_ID, "TELEGRAM_BOT_TOKEN"))?.value ?? null;
    await as(ownerA, () => connectTelegram(form({ token: `123456:${SFX}-fourbuy` })));
    const status = await as(ownerA, () => telegramStatus());
    check("the workspace's owner connects their bot", status.connected && status.enabled, JSON.stringify(status));
    check("…its token stored under THAT workspace", (await getWorkspaceSetting(A, "TELEGRAM_BOT_TOKEN")) === `123456:${SFX}-fourbuy`);
    const secret = await getWorkspaceSetting(A, "TELEGRAM_WEBHOOK_SECRET");
    check("…and its messages route to that workspace", Boolean(secret) && (await resolveTelegramTenant(secret)) === A);
    check("another workspace has no bot", !(await as(ownerB, () => telegramStatus())).connected);
    check("the founding workspace's bot is untouched", ((await setting(DEFAULT_TENANT_ID, "TELEGRAM_BOT_TOKEN"))?.value ?? null) === foundingToken);
    await as(ownerB, () => disconnectTelegram());
    check("another workspace's Disconnect leaves it connected", (await as(ownerA, () => telegramStatus())).connected);
  }

  console.log("\nA workspace's own WhatsApp number");
  {
    const phone = `9${Date.now()}`.slice(0, 15);
    await as(ownerA, () => saveTenantCredentialOverride(form({ key: "WA_PHONE_NUMBER_ID", value: phone })));
    await as(ownerA, () => saveTenantCredentialOverride(form({ key: "WA_ACCESS_TOKEN", value: `EAAG-${SFX}-fourbuy` })));
    const own = await resolveIntegrationBundle(A, "whatsapp");
    check("the workspace's owner saves their own number and token", own?.WA_PHONE_NUMBER_ID === phone && own?.WA_ACCESS_TOKEN === `EAAG-${SFX}-fourbuy`, JSON.stringify(own && Object.keys(own)));
    check("another workspace does not get them", (await resolveIntegrationBundle(B, "whatsapp")) === null);
    check("messages to that number route to that workspace", (await resolveChannelTenant("whatsapp", phone)) === A);
    await as(ownerB, () => saveTenantCredentialOverride(form({ key: "WA_PHONE_NUMBER_ID", value: phone })));
    await as(ownerB, () => saveTenantCredentialOverride(form({ key: "WA_ACCESS_TOKEN", value: `EAAG-${SFX}-other` })));
    check("another workspace saving the same number cannot take its messages", (await resolveChannelTenant("whatsapp", phone)) === A);
  }
}

main()
  .catch((error) => { failed++; console.error("\nUNEXPECTED ERROR", error); })
  .finally(async () => {
    globalThis.fetch = realFetch;
    __setTenantEnforcingForTests(null);
    await cleanup().catch((error) => { failed++; console.error("cleanup failed", error); });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
