/**
 * TAKING A LIVE CHATBOT FLOW OFFLINE (Sean, 2026-11-02: "there is no way to take a flow from live to off").
 *
 * Before this, the only way off was to publish another flow — and with nothing published the engine fell back to the
 * built-in default flow, so the chatbot still answered. On a real database, through the real publish and offline
 * functions as the owner, with the engine resolving in each workspace's own scope:
 *  - a published flow is what answers; another workspace cannot take it offline;
 *  - taken offline: nothing answers a new conversation (not the built-in default), the flow is no longer live and
 *    its publication is gone — but a QR/keyword route still starts its own flow, and a conversation already in the
 *    flow finishes on its pinned version;
 *  - the other workspace's live flow is untouched; a flow that isn't live can't be "taken offline";
 *  - publishing it again puts it back.
 *
 *   npm run test:flow-offline     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes what it creates.
 */
import { basePrisma } from "../src/lib/db";
import { publishFlowSnapshot, resolveFlowSnapshot, takeFlowOffline } from "../src/lib/flowPublishing";
import { normalizeRoutePattern } from "../src/lib/flowRouteRule";
import { runInTenantScope } from "../src/lib/tenantScope";
import { seedTwoTenants, teardown } from "./harness/seed";
import { actAsStaff } from "./harness/actAs";

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

const graph = (text: string) => JSON.stringify({ start: "hi", nodes: { hi: { id: "hi", type: "message", text, next: "end" }, end: { id: "end", type: "end" } } });

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`off${SFX}`);
  const { a, b } = fixture;
  const A = a.tenantId;
  const B = b.tenantId;
  const ownerA = <T>(work: () => Promise<T>) => actAsStaff(a, work, { asOwner: true });
  const ownerB = <T>(work: () => Promise<T>) => actAsStaff(b, work, { asOwner: true });
  const resolve = (tenantId: string, text?: string, pinned?: string | null) =>
    runInTenantScope({ tenantId, system: false }, () => resolveFlowSnapshot("whatsapp", pinned ?? null, text ? { text } : null));
  const QR = `Hi, please send the brochure ${SFX}`;

  try {
    const main = await basePrisma.botFlow.create({ data: { tenantId: A, name: `Main ${SFX}`, channel: "whatsapp", definition: graph("Main flow") }, select: { id: true } });
    const qrFlow = await basePrisma.botFlow.create({ data: { tenantId: A, name: `QR ${SFX}`, channel: "whatsapp", definition: graph("Brochure") }, select: { id: true } });
    const qrVersion = await basePrisma.botFlowVersion.create({ data: { tenantId: A, flowId: qrFlow.id, channel: "whatsapp", version: 1, definition: graph("Brochure") }, select: { id: true } });
    await basePrisma.botFlowRoute.create({ data: { tenantId: A, channel: "whatsapp", kind: "keyword", pattern: normalizeRoutePattern(QR), flowId: qrFlow.id, publishedVersionId: qrVersion.id, priority: 10 } });
    const bMain = await basePrisma.botFlow.create({ data: { tenantId: B, name: `B main ${SFX}`, channel: "whatsapp", definition: graph("B flow") }, select: { id: true } });

    const live = await ownerA(() => publishFlowSnapshot(main.id));
    await ownerB(() => publishFlowSnapshot(bMain.id));

    console.log("\nlive");
    check("the published flow answers", (await resolve(A))?.flowId === main.id);
    check("another workspace cannot take it offline", (await ownerB(() => takeFlowOffline(main.id))) === false && (await resolve(A))?.flowId === main.id);

    console.log("\ntaken offline");
    check("takeFlowOffline says it did", (await ownerA(() => takeFlowOffline(main.id))) === true);
    const off = await resolve(A);
    check("nothing answers a new conversation — not even the built-in default", off === null, JSON.stringify(off));
    const row = await basePrisma.botFlow.findUnique({ where: { id: main.id }, select: { active: true } });
    check("…the flow is no longer live, and its publication is gone", row?.active === false && (await basePrisma.botFlowPublication.count({ where: { tenantId: A, channel: "whatsapp" } })) === 0);
    check("…its versions are kept as history", (await basePrisma.botFlowVersion.count({ where: { tenantId: A, flowId: main.id } })) === 1);
    check("a QR code's message still starts its own flow", (await resolve(A, QR))?.flowId === qrFlow.id);
    check("a conversation already in the flow finishes on its pinned version", (await resolve(A, undefined, live.versionId))?.versionId === live.versionId);
    check("the other workspace's live flow is untouched", (await resolve(B))?.flowId === bMain.id);
    check("a flow that isn't live can't be taken offline", (await ownerA(() => takeFlowOffline(main.id))) === false);

    console.log("\npublished again");
    await ownerA(() => publishFlowSnapshot(main.id));
    check("it answers again", (await resolve(A))?.flowId === main.id);
  } finally {
    for (const tenantId of [A, B]) {
      await basePrisma.botFlowPublication.deleteMany({ where: { tenantId } }).catch(() => 0);
      await basePrisma.botFlowRoute.deleteMany({ where: { tenantId } }).catch(() => 0);
      await basePrisma.botFlowVersion.deleteMany({ where: { tenantId } }).catch(() => 0);
      await basePrisma.botFlow.deleteMany({ where: { tenantId } }).catch(() => 0);
    }
    await teardown(fixture);
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
