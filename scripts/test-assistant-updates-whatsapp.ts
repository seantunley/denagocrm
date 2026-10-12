/**
 * REAL-DATABASE proof of the bookkeeping behind "the assistant sends a scheduled
 * briefing to my phone": which answers are waiting, that one is claimed before
 * it is sent and released when it could not be, and that the "you have an
 * update" template is claimed once.
 *
 * tests/assistantWhatsApp.test.ts proves the decisions against fakes. Only a
 * database shows the columns exist and the guarded writes do what they say.
 *
 * NOTHING IS SENT. This database has no WhatsApp connection, so every send is
 * refused before it reaches Meta — and the script stops if it finds one.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, removes
 * every row it creates and puts back the two settings it changes.
 */
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { getSetting, putSetting } from "../src/lib/settings";
import { isWhatsAppConfigured } from "../src/lib/whatsapp";
import { readUserSecurityStateStrict } from "../src/lib/userSecurity";
import { sendUpdatesToLinkedPhone } from "../src/lib/assistantWhatsApp";
import { ASSISTANT_WHATSAPP_KEY, ASSISTANT_WHATSAPP_TEMPLATE_KEY } from "../src/lib/assistantWhatsAppRules";

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

const T = DEFAULT_TENANT_ID;
const USER = `asst-upd-user-${SFX}`;
const LINK = `asst-upd-link-${SFX}`;
// Not a real number: 27 followed by zeros and the run's digits.
const PHONE = `2700000${String(parseInt(SFX, 16)).slice(0, 4).padStart(4, "0")}`;
const TURN = { brief: `asst-upd-brief-${SFX}`, alert: `asst-upd-alert-${SFX}`, typed: `asst-upd-typed-${SFX}`, stale: `asst-upd-stale-${SFX}` };
const HOUR = 3_600_000;
const scoped = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: T, system: false }, fn);
const link = () => basePrisma.assistantPhoneLink.findUniqueOrThrow({ where: { id: LINK } });
const sentAt = async (id: string) => (await basePrisma.assistantTurn.findUniqueOrThrow({ where: { id }, select: { whatsappSentAt: true } })).whatsappSentAt;

async function main() {
  guardEnvironment();
  const before = await scoped(async () => ({ on: await getSetting(ASSISTANT_WHATSAPP_KEY), template: await getSetting(ASSISTANT_WHATSAPP_TEMPLATE_KEY) }));
  try {
    if (await scoped(() => isWhatsAppConfigured())) throw new Error("This database has a WhatsApp connection: refusing to run, a message could really be sent");
    await basePrisma.user.create({ data: { id: USER, name: "Updates", email: `${USER}@example.invalid`, passwordHash: "test", role: "member", modules: "crm" } });
    // The account's sign-in version lives outside the Prisma model: read as the application reads it.
    const security = await readUserSecurityStateStrict(USER);
    await basePrisma.assistantPhoneLink.create({ data: { id: LINK, tenantId: T, userId: USER, waId: PHONE, verifiedAt: new Date(), sessionVersion: security?.sessionVersion ?? 0 } });
    const turn = (id: string, source: string, hoursAgo: number) => ({ id, tenantId: T, userId: USER, question: "Morning brief", answer: "Three follow-ups today.", source, createdAt: new Date(Date.now() - hoursAgo * HOUR) });
    await basePrisma.assistantTurn.createMany({ data: [turn(TURN.brief, "schedule", 1), turn(TURN.alert, "watch", 2), turn(TURN.typed, "chat", 1), turn(TURN.stale, "schedule", 30)] });
    await scoped(() => putSetting(ASSISTANT_WHATSAPP_KEY, "on"));
    await scoped(() => putSetting(ASSISTANT_WHATSAPP_TEMPLATE_KEY, ""));
    const run = (opts?: { windowOpen?: boolean }) => scoped(() => sendUpdatesToLinkedPhone(T, USER, opts));

    console.log("\nA new link");
    const fresh = await link();
    check("sends updates to the phone unless the person says otherwise", fresh.updatesOnWhatsApp === true);
    check("has never written in, and has never been nudged", fresh.lastInboundAt === null && fresh.nudgedAt === null);

    console.log("\nOutside the 24 hours");
    check("with no template it waits", (await run()) === "waiting");
    check("…and nothing is marked as sent", (await sentAt(TURN.brief)) === null && (await sentAt(TURN.alert)) === null);
    await scoped(() => putSetting(ASSISTANT_WHATSAPP_TEMPLATE_KEY, "assistant_update_ready|en"));
    // No WhatsApp connection here, so the template is refused — after it was claimed.
    check("with a template, the nudge is claimed before it is sent", (await run()) === "failed" && (await link()).nudgedAt !== null);
    check("…and a second run does not try the template again", (await run()) === "waiting");
    check("…and the briefing is still waiting", (await sentAt(TURN.brief)) === null);

    console.log("\nInside the 24 hours");
    await basePrisma.assistantPhoneLink.update({ where: { id: LINK }, data: { lastInboundAt: new Date(), nudgedAt: null } });
    // The send is refused (no connection): the claim must be given back, or the briefing would never arrive.
    check("a briefing that could not be sent is released, not lost", (await run()) === "failed" && (await sentAt(TURN.brief)) === null && (await sentAt(TURN.alert)) === null);
    await basePrisma.assistantTurn.updateMany({ where: { id: { in: [TURN.brief, TURN.alert] } }, data: { whatsappSentAt: new Date() } });
    check("once both have gone there is nothing left: a typed answer and a day-old briefing are never sent", (await run()) === "nothing");
    check("…and those two were never claimed", (await sentAt(TURN.typed)) === null && (await sentAt(TURN.stale)) === null);

    console.log("\nWho it is for");
    await basePrisma.assistantTurn.update({ where: { id: TURN.brief }, data: { whatsappSentAt: null } });
    await basePrisma.assistantPhoneLink.update({ where: { id: LINK }, data: { updatesOnWhatsApp: false } });
    check("the person's own switch off: nothing is sent or claimed", (await run()) === "not_wanted" && (await sentAt(TURN.brief)) === null);
    await basePrisma.assistantPhoneLink.update({ where: { id: LINK }, data: { updatesOnWhatsApp: true } });
    await basePrisma.$executeRaw`UPDATE "User" SET "sessionVersion" = "sessionVersion" + 1 WHERE "id" = ${USER}`;
    check("sign-ins reset since the phone was linked: not safe, nothing claimed", (await run()) === "not_safe" && (await sentAt(TURN.brief)) === null);
    await scoped(() => putSetting(ASSISTANT_WHATSAPP_KEY, "off"));
    check("the workspace switch off: nothing", (await run()) === "not_wanted");
  } finally {
    await basePrisma.assistantTurn.deleteMany({ where: { id: { in: Object.values(TURN) } } });
    await basePrisma.assistantPhoneLink.deleteMany({ where: { id: LINK } });
    await basePrisma.user.deleteMany({ where: { id: USER } });
    await scoped(() => putSetting(ASSISTANT_WHATSAPP_KEY, before.on ?? ""));
    await scoped(() => putSetting(ASSISTANT_WHATSAPP_TEMPLATE_KEY, before.template ?? ""));
  }
}

main()
  .catch((error) => { failed++; console.error(error); })
  .finally(async () => {
    console.log(`\n${passed} passed, ${failed} failed`);
    await basePrisma.$disconnect();
    process.exit(failed === 0 ? 0 : 1);
  });
