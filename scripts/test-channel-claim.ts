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
import { withMetaConnectLock } from "../src/lib/metaConnect";

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
  } finally {
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
