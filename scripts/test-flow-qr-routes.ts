/**
 * A QR CODE NEVER TAKES OVER OR DELETES SOMEONE ELSE'S ROUTE (review of #948).
 *
 * A QR code is a WhatsApp keyword route on its pre-typed message. It used to be saved with an upsert on
 * (channel, kind, pattern), so a QR whose message matched an ordinary keyword route quietly re-pointed that route
 * at the QR's flow — and deleting the QR then deleted the route. Here, on a real database, through the real
 * actions and a real owner session (scripts/harness/actAs.ts), every verdict read back from the rows:
 *  - a QR on an ordinary route's message is refused, and that route is exactly as it was;
 *  - a QR on its own message makes its own route; deleting it removes that route only;
 *  - an ordinary route on a QR's message is refused;
 *  - deleting a QR's route from the routing table removes its QR entry too, freeing the name.
 *
 *   npm run test:flow-qr-routes     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes what it creates.
 */
import { basePrisma } from "../src/lib/db";
import { addFlowQr, addFlowRoute, deleteFlowQr, deleteFlowRoute } from "../src/app/actions/flow";
import { FLOW_QR_KEY, parseQrCodes, qrPattern } from "../src/lib/flowQr";
import { getSetting } from "../src/lib/settings";
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

const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
};
const settled = <T>(work: Promise<T>) => work.then((value) => ({ value, threw: null as unknown }), (error: unknown) => ({ value: null, threw: error }));

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`qr${SFX}`);
  const { a } = fixture;
  const A = a.tenantId;
  const owner = <T>(work: () => Promise<T>) => actAsStaff(a, work, { asOwner: true });
  const definition = JSON.stringify({ start: "end", nodes: { end: { id: "end", type: "end" } } });
  const flows: string[] = [];
  const makeFlow = async (name: string) => {
    const flow = await basePrisma.botFlow.create({ data: { tenantId: A, name: `${name} ${SFX}`, channel: "whatsapp", definition }, select: { id: true } });
    const version = await basePrisma.botFlowVersion.create({ data: { tenantId: A, flowId: flow.id, channel: "whatsapp", version: 1, definition }, select: { id: true } });
    flows.push(flow.id);
    return { flowId: flow.id, versionId: version.id };
  };
  const qrList = async () => parseQrCodes(await owner(() => getSetting(FLOW_QR_KEY)));

  try {
    const sales = await makeFlow("Sales");
    const brochure = await makeFlow("Brochure");
    const taken = "Hi Denago, I'd like a price";
    const ordinary = await basePrisma.botFlowRoute.create({
      data: { tenantId: A, channel: "whatsapp", kind: "keyword", pattern: qrPattern(taken), flowId: sales.flowId, publishedVersionId: sales.versionId, priority: 100 },
    });

    console.log("\na QR code on an ordinary route's message");
    const clash = await settled(owner(() => addFlowQr(form({ name: "Show stand", message: taken, flowId: brochure.flowId }))));
    check("is refused", Boolean(clash.value && "error" in clash.value && clash.value.error), JSON.stringify(clash));
    const after = await basePrisma.botFlowRoute.findUnique({ where: { id: ordinary.id } });
    check("…and the ordinary route is exactly as it was", Boolean(after) && after!.flowId === sales.flowId && after!.priority === 100 && after!.enabled && after!.updatedAt.getTime() === ordinary.updatedAt.getTime(), JSON.stringify(after));
    check("…and no QR code was saved", (await qrList()).length === 0);

    console.log("\na QR code on its own message");
    const own = "Hi Denago, please send me the brochure";
    const made = await settled(owner(() => addFlowQr(form({ name: "Show stand", message: own, flowId: brochure.flowId }))));
    const codes = await qrList();
    check("is saved, with a route of its own", Boolean(made.value && "success" in made.value) && codes.length === 1 && codes[0].routeId !== ordinary.id, JSON.stringify({ made, codes }));
    const qrRoute = codes[0]?.routeId ?? "";

    console.log("\nan ordinary route on the QR's message");
    const hijack = await settled(owner(() => addFlowRoute(form({ channel: "whatsapp", kind: "keyword", pattern: own, flowId: sales.flowId, priority: "100" }))));
    check("is refused", Boolean(hijack.value && "error" in hijack.value && hijack.value.error), JSON.stringify(hijack));
    const qrRow = await basePrisma.botFlowRoute.findUnique({ where: { id: qrRoute } });
    check("…and the QR's route still starts the brochure flow", qrRow?.flowId === brochure.flowId && qrRow?.priority === 10, JSON.stringify(qrRow));

    console.log("\ndeleting the QR code");
    await settled(owner(() => deleteFlowQr(qrRoute)));
    check("removes its own route", (await basePrisma.botFlowRoute.findUnique({ where: { id: qrRoute } })) === null);
    check("…and never the ordinary route", Boolean(await basePrisma.botFlowRoute.findUnique({ where: { id: ordinary.id } })));
    check("…and its QR entry", (await qrList()).length === 0);

    console.log("\ndeleting a QR's route from the routing table");
    await settled(owner(() => addFlowQr(form({ name: "Flyer", message: own, flowId: brochure.flowId }))));
    const flyer = (await qrList())[0];
    check("(a QR code made again)", Boolean(flyer));
    await settled(owner(() => deleteFlowRoute(flyer?.routeId ?? "")));
    check("removes its QR entry with it", (await qrList()).length === 0);
    const again = await settled(owner(() => addFlowQr(form({ name: "Flyer", message: own, flowId: brochure.flowId }))));
    check("…so its name can be used again", Boolean(again.value && "success" in again.value), JSON.stringify(again));
  } finally {
    await basePrisma.botFlowRoute.deleteMany({ where: { tenantId: A, flowId: { in: flows } } }).catch(() => 0);
    await basePrisma.botFlowVersion.deleteMany({ where: { tenantId: A, flowId: { in: flows } } }).catch(() => 0);
    await basePrisma.botFlow.deleteMany({ where: { tenantId: A, id: { in: flows } } }).catch(() => 0);
    await basePrisma.appSetting.deleteMany({ where: { tenantId: A, key: FLOW_QR_KEY } }).catch(() => 0);
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
