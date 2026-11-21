/**
 * REAL-DATABASE: two workspaces claiming the same account AT THE SAME TIME (reviews of #1181 / #1182, 2026-11-21).
 *
 * lib/channelClaim.ts must let exactly one win — every time, against a real Postgres — and must never move an account
 * a workspace actively holds to another. Run in CI against a *_test database only.
 */
import { basePrisma } from "../src/lib/db";
import { claimChannelEndpoint } from "../src/lib/channelClaim";
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
    basePrisma.channelIdentity.findUnique({ where: { channel_externalId: { channel: "x", externalId } }, select: { tenantId: true, disabledAt: true } });
  try {
    // 1. A brand-new account, both workspaces at once — ten rounds.
    let racesOk = 0;
    for (let round = 0; round < 10; round++) {
      const id = `race-${SFX}-${round}`;
      ids.push(id);
      const [a, b] = await Promise.all([claimChannelEndpoint(A, "x", id, "@a"), claimChannelEndpoint(B, "x", id, "@b")]);
      const row = await owner(id);
      const winner = a ? A : B;
      if (a !== b && row?.tenantId === winner && row.disabledAt === null) racesOk++;
    }
    check("a new account raced by two workspaces: exactly one wins, and owns it (10 of 10 rounds)", racesOk === 10, `${racesOk}/10`);

    // 2. An account A actively holds: B is refused, and the row stays A's.
    const held = `held-${SFX}`;
    ids.push(held);
    await claimChannelEndpoint(A, "x", held, "@a");
    check("another workspace can't take an account that is actively held", (await claimChannelEndpoint(B, "x", held, "@b")) === false);
    check("…and it is still the holder's", (await owner(held))?.tenantId === A);
    check("the holder re-connecting its own account is fine", (await claimChannelEndpoint(A, "x", held, "@a2")) === true);

    // 3. A retired account, raced: exactly one takes it.
    const retired = `retired-${SFX}`;
    ids.push(retired);
    await claimChannelEndpoint(A, "x", retired, "@a");
    await basePrisma.channelIdentity.updateMany({ where: { channel: "x", externalId: retired }, data: { disabledAt: new Date() } });
    const [ra, rb] = await Promise.all([claimChannelEndpoint(A, "x", retired, "@a"), claimChannelEndpoint(B, "x", retired, "@b")]);
    const after = await owner(retired);
    check("a retired account raced by two workspaces: exactly one takes it", ra !== rb && after?.disabledAt === null && after?.tenantId === (ra ? A : B));
  } finally {
    await basePrisma.channelIdentity.deleteMany({ where: { channel: "x", externalId: { in: ids } } });
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
