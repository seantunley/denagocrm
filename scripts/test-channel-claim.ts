/**
 * REAL-DATABASE: two workspaces claiming the same account AT THE SAME TIME (reviews of #1181 / #1182, 2026-11-21).
 *
 * lib/channelClaim.ts must let exactly one win — every time, against a real Postgres — and must never move an account
 * a workspace actively holds to another. Run in CI against a *_test database only.
 *
 * On the `messenger` channel: known to every branch, and — unlike `x`, which allows one active account per workspace
 * (ChannelIdentity_one_active_x_per_tenant) — free of a per-workspace limit that would refuse the extra test accounts.
 */
import { basePrisma } from "../src/lib/db";
import { claimChannelEndpoint } from "../src/lib/channelClaim";
import { PENDING_KEY, connectMetaPage, withMetaConnectLock } from "../src/lib/metaConnect";
import { CONNECTED } from "../src/lib/metaPage";
import { putSetting, putTenantCredentialBundle, putWorkspaceSetting, resolveTenantCredential } from "../src/lib/settings";
import { connectWhatsAppNumber, disconnectWhatsApp, startWhatsAppSignup } from "../src/lib/whatsappConnect";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { withSystemScope } from "../src/lib/tenantScopeEntry";

const LOCK = "META_CONNECT_LOCK";
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

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`cc${SFX}`);
  const A = fixture.a.tenantId;
  const B = fixture.b.tenantId;
  const ids: string[] = [];
  const phones: string[] = [];
  const realFetch = globalThis.fetch;
  let platformBefore: Awaited<ReturnType<typeof basePrisma.appSetting.findMany>> | null = null;
  const owner = async (externalId: string) =>
    basePrisma.channelIdentity.findUnique({ where: { channel_externalId: { channel: "messenger", externalId } }, select: { tenantId: true, disabledAt: true } });
  try {
    // 1. A brand-new account, both workspaces at once — ten rounds.
    let racesOk = 0;
    for (let round = 0; round < 10; round++) {
      const id = `race-${SFX}-${round}`;
      ids.push(id);
      const [a, b] = await Promise.all([claimChannelEndpoint(A, "messenger", id, "@a"), claimChannelEndpoint(B, "messenger", id, "@b")]);
      const row = await owner(id);
      const winner = a ? A : B;
      if (a !== b && row?.tenantId === winner && row.disabledAt === null) racesOk++;
    }
    check("a new account raced by two workspaces: exactly one wins, and owns it (10 of 10 rounds)", racesOk === 10, `${racesOk}/10`);

    // 2. An account A actively holds: B is refused, and the row stays A's.
    const held = `held-${SFX}`;
    ids.push(held);
    await claimChannelEndpoint(A, "messenger", held, "@a");
    check("another workspace can't take an account that is actively held", (await claimChannelEndpoint(B, "messenger", held, "@b")) === false);
    check("…and it is still the holder's", (await owner(held))?.tenantId === A);
    check("the holder re-connecting its own account is fine", (await claimChannelEndpoint(A, "messenger", held, "@a2")) === true);

    // 3. A retired account, raced: exactly one takes it.
    const retired = `retired-${SFX}`;
    ids.push(retired);
    await claimChannelEndpoint(A, "messenger", retired, "@a");
    await basePrisma.channelIdentity.updateMany({ where: { channel: "messenger", externalId: retired }, data: { disabledAt: new Date() } });
    const [ra, rb] = await Promise.all([claimChannelEndpoint(A, "messenger", retired, "@a"), claimChannelEndpoint(B, "messenger", retired, "@b")]);
    const after = await owner(retired);
    check("a retired account raced by two workspaces: exactly one takes it", ra !== rb && after?.disabledAt === null && after?.tenantId === (ra ? A : B));

    // 4. ONE Connect/Disconnect Facebook at a time per workspace (second review of #1182): a lease row, not a lock held
    //    across Meta's API calls. Two at once: one runs, the other is told to wait; another workspace is never held up.
    let inside = 0;
    let most = 0;
    const slow = (tenantId: string) => withMetaConnectLock(tenantId, async () => {
      inside++;
      most = Math.max(most, inside);
      await new Promise((resolve) => setTimeout(resolve, 300));
      inside--;
      return "ran";
    });
    const both = await Promise.allSettled([slow(A), slow(A)]);
    check("two at once in one workspace: exactly one runs", both.filter((r) => r.status === "fulfilled").length === 1 && most === 1);
    const lease = () => basePrisma.appSetting.findUnique({ where: { tenantId_key: { tenantId: A, key: LOCK } }, select: { value: true } });
    check("…and the lease is gone afterwards", (await lease()) === null);
    most = 0;
    const [own, other] = await Promise.allSettled([slow(A), slow(B)]);
    check("another workspace is never held up", own.status === "fulfilled" && other.status === "fulfilled");
    await basePrisma.appSetting.create({ data: { tenantId: A, key: LOCK, value: String(Date.now() + 60_000) } });
    check("a live lease refuses", await withMetaConnectLock(A, async () => "ran").then(() => false, () => true));
    await basePrisma.appSetting.updateMany({ where: { tenantId: A, key: LOCK }, data: { value: String(Date.now() - 1_000) } });
    check("a crashed holder's expired lease is taken over", (await withMetaConnectLock(A, async () => "ran")) === "ran" && (await lease()) === null);

    // 5. A claim that THROWS part-way (review of #1185): the Page is claimed, then the Instagram lookup errors (a NUL in
    //    the id — Postgres refuses it). The Page just claimed must be released and the previous connection left alone.
    //    It fails before Meta is called, so no network.
    const page = `pg-${SFX}`;
    const oldPage = `old-${SFX}`;
    ids.push(page, oldPage);
    await putTenantCredentialBundle(A, { [CONNECTED.pageId]: oldPage, [CONNECTED.pageToken]: "old-token" });
    await putWorkspaceSetting(A, PENDING_KEY, JSON.stringify({ expiresAt: Date.now() + 60_000, metaUserId: "1", scopes: [], pages: [{ id: page, name: "Test Page", token: "t", igId: `ig\u0000${SFX}` }] }));
    const thrown = await connectMetaPage({ tenantId: A, pageId: page }).then(() => null, (error: unknown) => error);
    check("a claim that throws part-way fails the connect", thrown instanceof Error);
    check("…releases the Page it had just claimed", (await owner(page))?.disabledAt != null, JSON.stringify(await owner(page)));
    const kept = await basePrisma.tenantIntegrationCredential.findMany({ where: { tenantId: A, key: { in: Object.values(CONNECTED) } }, select: { key: true } });
    check("…and leaves the previous connection exactly as it was", kept.length === 2, kept.map((row) => row.key).join(","));
    check("…and the lease is gone", (await lease()) === null);

    // 6. CONNECT WHATSAPP, two at once (review of #1187), against a fake Meta (no network) that answers slowly so the
    //    attempts overlap. Shares the lease above: two tabs, or a connect and a disconnect, never interleave; a refused
    //    attempt keeps its state and can be retried; every number's PIN survives, and a failed register keeps its PIN.
    const platformKeys = ["META_APP_ID", "META_APP_SECRET", "WA_SIGNUP_CONFIG_ID"];
    platformBefore = await basePrisma.appSetting.findMany({ where: { tenantId: DEFAULT_TENANT_ID, key: { in: platformKeys } } });
    await withSystemScope(async () => {
      await putSetting("META_APP_ID", "1000");
      await putSetting("META_APP_SECRET", "fake-secret");
      await putSetting("WA_SIGNUP_CONFIG_ID", "2000");
    });
    phones.push(`9${SFX}1`, `9${SFX}2`, `9${SFX}3`);
    const metaGot: { phone: string; pin: string }[] = [];
    let registerFails = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const path = url.pathname.replace(/^\/v[\d.]+\//, "");
      const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (path === "oauth/access_token") return reply({ access_token: `token-${url.searchParams.get("code")}` });
      if (path.endsWith("/phone_numbers")) return reply({ data: phones.map((id) => ({ id, display_phone_number: `+27 ${id.slice(-4)}`, verified_name: "Test" })) });
      if (path.endsWith("/subscribed_apps")) return reply({ success: true });
      if (path.endsWith("/register")) {
        metaGot.push({ phone: path.split("/")[0], pin: String((JSON.parse(String(init?.body ?? "{}")) as { pin?: string }).pin) });
        return registerFails ? reply({ error: { message: "Timed out" } }, 504) : reply({ success: true });
      }
      return reply({ display_phone_number: "+27 0000", verified_name: "Test" });
    }) as typeof fetch;
    const begin = async () => (await startWhatsAppSignup({ tenantId: A, userId: "test", origin: "https://a.example" }))!.state;
    const connectWa = (state: string, phone: string) => connectWhatsAppNumber({ tenantId: A, state, code: `c-${phone}`, wabaId: "111", phoneNumberId: phone });
    const pins = async () => JSON.parse((await resolveTenantCredential(A, "WA_REGISTER_PINS")) ?? "{}") as Record<string, string>;
    const current = () => resolveTenantCredential(A, "WA_PHONE_NUMBER_ID");

    const [s1, s2] = [await begin(), await begin()];
    const pair = await Promise.allSettled([connectWa(s1, phones[0]), connectWa(s2, phones[1])]);
    const won = pair.findIndex((r) => r.status === "fulfilled");
    const lost = pair.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    check("WhatsApp: two connects at once in one workspace — exactly one runs", won >= 0 && pair.filter((r) => r.status === "fulfilled").length === 1 && /already being changed/.test(String(lost?.reason?.message)), String(lost?.reason));
    check("…the winner's number is the one stored", (await current()) === phones[won]);
    const retry = won === 0 ? connectWa(s2, phones[1]) : connectWa(s1, phones[0]);
    check("…the refused attempt kept its state and connects on retry", (await retry.then(() => true, () => false)) && (await current()) === phones[1 - won]);
    const savedPins = await pins();
    check("…and BOTH numbers' PINs are kept, each the one Meta was given", [0, 1].every((i) => /^\d{6}$/.test(savedPins[phones[i]] ?? "") && metaGot.some((got) => got.phone === phones[i] && got.pin === savedPins[phones[i]])), JSON.stringify(Object.keys(savedPins)));

    const s3 = await begin();
    const race = await Promise.allSettled([disconnectWhatsApp(A), connectWa(s3, phones[0])]);
    check("WhatsApp: a disconnect and a connect at once — exactly one runs", race.filter((r) => r.status === "fulfilled").length === 1);

    registerFails = true;
    const s4 = await begin();
    check("WhatsApp: Meta failing (or timing out) at register fails the connect", await connectWa(s4, phones[2]).then(() => false, () => true));
    const kept3 = (await pins())[phones[2]];
    check("…but the PIN it was sent is kept", /^\d{6}$/.test(kept3 ?? "") && metaGot.at(-1)?.pin === kept3);
    registerFails = false;
    const s5 = await begin();
    await connectWa(s5, phones[2]);
    check("…and the retry registers with the SAME PIN", metaGot.at(-1)?.phone === phones[2] && metaGot.at(-1)?.pin === kept3);
    check("…the lease is gone", (await lease()) === null);
  } finally {
    globalThis.fetch = realFetch;
    if (platformBefore) {
      await basePrisma.appSetting.deleteMany({ where: { tenantId: DEFAULT_TENANT_ID, key: { in: ["META_APP_ID", "META_APP_SECRET", "WA_SIGNUP_CONFIG_ID"] } } });
      if (platformBefore.length) await basePrisma.appSetting.createMany({ data: platformBefore });
    }
    await basePrisma.tenantIntegrationCredential.deleteMany({ where: { tenantId: { in: [A, B] }, key: { startsWith: "WA_" } } });
    await basePrisma.appSetting.deleteMany({ where: { tenantId: { in: [A, B] }, key: { startsWith: "WA_SIGNUP:" } } });
    await basePrisma.channelIdentity.deleteMany({ where: { channel: "whatsapp", externalId: { in: phones } } });
    await basePrisma.tenantIntegrationCredential.deleteMany({ where: { tenantId: { in: [A, B] }, key: { in: Object.values(CONNECTED) } } });
    await basePrisma.appSetting.deleteMany({ where: { tenantId: { in: [A, B] }, key: PENDING_KEY } });
    await basePrisma.appSetting.deleteMany({ where: { tenantId: { in: [A, B] }, key: LOCK } });
    await basePrisma.channelIdentity.deleteMany({ where: { channel: "messenger", externalId: { in: ids } } });
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
