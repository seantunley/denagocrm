/**
 * DAX ADDS TO THE CRM, on a real database (Sean, 2026-11-02): a NEW CUSTOMER from a contact shared off his
 * phone, and a SCREENSHOT pinned to a lead or customer.
 *
 *   npm run test:assistant-add-to-crm     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * What a source test cannot show, through the SCOPED client with enforcement on:
 *  - the card is made by the real resolveActions, with every field shown;
 *  - a number or email already on a customer — written another way, and on one the person cannot open — makes
 *    no card, and the one they cannot open is not named;
 *  - Confirm (the real server action) creates exactly that customer, in this workspace, visible to its creator;
 *  - Confirm again creates nothing more;
 *  - a role without contacts.create gets no card, and a forged card creates nothing;
 *  - a screenshot is kept for the reply that follows, and only that one; another workspace never sees it; the
 *    hourly clean-up deletes it;
 *  - Confirm pins it to the customer's timeline through the note form's own upload; a forged picture is refused.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database or with a file-store key set (uploads go to
 * the local folder), and removes every row and file it creates (except append-only audit events). The model is
 * never called; nobody is contacted.
 */
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { canAccessContact, type PermissionUser } from "../src/lib/permissions";
import type { ActionCard } from "../src/lib/assistantActions";
import { resolveActions } from "../src/lib/crmAssistant";
import { runAssistantAction } from "../src/app/actions/assistant";
import { signFreshSession } from "../src/lib/session";
import { runAsSession, type ActingSession } from "./harness/actingSession";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { cleanJpeg, jpegDataUrl } from "../src/lib/assistantImage";
import { carriedImage, pruneAssistantImages, rememberImage } from "../src/lib/assistantImageCarry";

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
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_PRIVATE_READ_WRITE_TOKEN) throw new Error("Refusing to run with a file-store key set — the screenshot must go to the local folder");
}

const id = (what: string) => `asst-newc-${what}-${SFX}`;
const T = DEFAULT_TENANT_ID;
const rep: PermissionUser = { id: id("rep"), name: "Rep", email: `${id("rep")}@example.invalid`, role: "member" };
const other: PermissionUser = { id: id("other"), name: "Other", email: `${id("other")}@example.invalid`, role: "member" };
// A NON-OWNER whose role is a sales rep's, without contacts.create.
const limited: PermissionUser = { id: id("limited"), name: "Limited", email: `${id("limited")}@example.invalid`, role: "member" };
const USERS = [rep, other, limited];
const ROLE = id("role");
const OTHER_TENANT = id("tenant");
// Unique digits per run, so another run's rows (or the seed's) never match.
const digits = String(Date.now()).slice(-7);
const ANNA_PHONE = `082 1${digits.slice(1)}`; // the OTHER rep's customer — rep cannot open her
const BEN_EMAIL = `ben-${SFX}@example.invalid`; // rep's own customer
const JANE_PHONE = `+27 83 ${digits.slice(0, 3)} ${digits.slice(3)}`;
const scoped = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: T, system: false }, fn);

async function seed() {
  await basePrisma.tenant.create({ data: { id: OTHER_TENANT, name: `Add-to-CRM test ${SFX}`, slug: `add-to-crm-${SFX}` } });
  await basePrisma.user.createMany({ data: USERS.map((u) => ({ id: u.id, name: u.name, email: u.email, passwordHash: "test", role: "member", modules: "crm" })) });
  await basePrisma.role.create({ data: { id: ROLE, tenantId: T, name: `New customer limited ${SFX}` } });
  await basePrisma.$executeRaw`
    INSERT INTO "RolePermission" ("roleId", "permissionKey", "tenantId")
    SELECT ${ROLE}, "permissionKey", ${T} FROM "RolePermission" WHERE "roleId" = 'role_sales_rep' AND "permissionKey" <> 'contacts.create'`;
  await basePrisma.$executeRaw`
    INSERT INTO "UserRole" ("id", "userId", "roleId", "tenantId") VALUES
      (gen_random_uuid()::text, ${rep.id}, 'role_sales_rep', ${T}),
      (gen_random_uuid()::text, ${other.id}, 'role_sales_rep', ${T}),
      (gen_random_uuid()::text, ${limited.id}, ${ROLE}, ${T})`;
  await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id", "tenantId", "userId") VALUES (${id("tm-rep")}, ${T}, ${rep.id}), (${id("tm-other")}, ${T}, ${other.id}), (${id("tm-limited")}, ${T}, ${limited.id})`;
  await basePrisma.contact.create({ data: { id: id("c-anna"), tenantId: T, firstName: "Anna", lastName: `Hidden${SFX}`, phone: ANNA_PHONE, ownerId: other.id, createdById: other.id } });
  await basePrisma.contact.create({ data: { id: id("c-ben"), tenantId: T, firstName: "Ben", lastName: `Mine${SFX}`, email: BEN_EMAIL, ownerId: rep.id, createdById: rep.id } });
}

async function sessionFor(user: PermissionUser): Promise<ActingSession> {
  return { cookieValue: await signFreshSession({ id: user.id, name: user.name ?? "", email: user.email ?? "", role: user.role, grants: "", sessionVersion: 0 }, 60, { tid: T }), label: user.name ?? user.id };
}

async function cleanup() {
  const ids = USERS.map((u) => u.id);
  const contacts = (await basePrisma.contact.findMany({ where: { createdById: { in: ids } }, select: { id: true } })).map((c) => c.id);
  const notes = await basePrisma.communication.findMany({ where: { userId: { in: ids } }, select: { id: true, attachmentUrl: true } });
  for (const note of notes) if (note.attachmentUrl && !note.attachmentUrl.includes("/")) await rm(path.join(process.cwd(), "storage", "uploads", note.attachmentUrl), { force: true });
  await basePrisma.$executeRaw`DELETE FROM "TimelinePin" WHERE "itemId" IN (SELECT "id" FROM "Communication" WHERE "userId" IN (${rep.id}, ${other.id}, ${limited.id}))`;
  await basePrisma.communication.deleteMany({ where: { userId: { in: ids } } });
  await basePrisma.assistantImage.deleteMany({ where: { userId: { in: ids } } });
  await basePrisma.assistantTurn.deleteMany({ where: { userId: { in: ids } } });
  await basePrisma.auditLog.deleteMany({ where: { OR: [{ contactId: { in: contacts } }, { userId: { in: ids } }] } });
  await basePrisma.contact.deleteMany({ where: { id: { in: contacts } } });
  await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${rep.id}, ${other.id}, ${limited.id})`;
  await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "userId" IN (${rep.id}, ${other.id}, ${limited.id})`;
  await basePrisma.role.deleteMany({ where: { id: ROLE } });
  await basePrisma.user.deleteMany({ where: { id: { in: ids } } });
  await basePrisma.tenant.deleteMany({ where: { id: OTHER_TENANT } });
}

const propose = async (user: PermissionUser, session: ActingSession, proposal: Record<string, unknown>) => {
  const problems: string[] = [];
  const cards = await runAsSession(session, () => scoped(() => resolveActions(user, [{ type: "create_customer", ...proposal } as never], problems, null)));
  return { cards, problems, card: cards.find((c): c is Extract<ActionCard, { kind: "create_customer" }> => c.kind === "create_customer") };
};
const janes = () => basePrisma.contact.findMany({ where: { firstName: "Jane", lastName: `New${SFX}`, deletedAt: null } });

async function main() {
  guardEnvironment();
  __setTenantEnforcingForTests(true);
  await seed();
  const repSession = await sessionFor(rep);
  const limitedSession = await sessionFor(limited);

  console.log("\nThe card");
  const jane = { firstName: "Jane", lastName: `New${SFX}`, phone: JANE_PHONE, email: `jane-${SFX}@example.invalid`, company: "Smith Farms" };
  const { card, problems } = await propose(rep, repSession, jane);
  check("one card, every field shown, nothing created yet", !!card && card.detail.includes(`Phone: ${JANE_PHONE}`) && card.detail.includes("Company: Smith Farms") && (await janes()).length === 0, JSON.stringify({ card, problems }));

  console.log("\nAlready a customer");
  {
    const written = `+27${ANNA_PHONE.replace(/\D/g, "").slice(1)}`; // 082… as +2782…
    const hidden = await propose(rep, repSession, { firstName: "Anna", phone: written });
    check("the same number written another way: no card", !hidden.card, JSON.stringify(hidden.cards));
    check("…and a customer they cannot open is not named", /one you can't open/.test(hidden.problems.join(" ")) && !hidden.problems.join(" ").includes("Hidden"), hidden.problems.join(" | "));
    const mine = await propose(rep, repSession, { firstName: "Ben", email: BEN_EMAIL.toUpperCase() });
    check("the same email in capitals: no card, and their own customer is named", !mine.card && mine.problems.join(" ").includes(`Ben Mine${SFX} is already in the CRM`), mine.problems.join(" | "));
    const nothing = await propose(rep, repSession, { firstName: "Nobody" });
    check("no phone and no email: no card, and DAX asks for one", !nothing.card && /needs a phone number or an email/.test(nothing.problems.join(" ")));
  }

  console.log("\nConfirm");
  {
    const done = await runAsSession(repSession, () => scoped(() => runAssistantAction(card!)));
    const rows = await janes();
    const row = rows[0];
    check("creates exactly that customer", done.ok && rows.length === 1 && row.phone === JANE_PHONE && row.email === jane.email && row.company === "Smith Farms", JSON.stringify({ done, rows }));
    check("in this workspace, created by the confirmer", row?.tenantId === T && row.createdById === rep.id);
    check("and the confirmer can open it (link back to it)", !!row && (await runAsSession(repSession, () => scoped(() => canAccessContact(rep, row.id)))) && done.href === `/contacts/${row?.id}`);
    const again = await runAsSession(repSession, () => scoped(() => runAssistantAction(card!)));
    check("Confirm again: refused before any write, nothing more created", !again.ok && again.unchanged === true && /already in the CRM/.test(again.error ?? "") && (await janes()).length === 1, JSON.stringify(again));
  }

  console.log("\nA role that cannot add customers");
  {
    const other = { ...jane, lastName: `New${SFX}`, phone: "+27 84 000 0001".replace("0001", digits.slice(-4)), email: `jane2-${SFX}@example.invalid` };
    const { card: none, problems: why } = await propose(limited, limitedSession, other);
    check("no card, and it says why", !none && /Your role can't add customers/.test(why.join(" ")), why.join(" | "));
    // A card forged in the browser, Confirmed anyway: createContact's own permission check refuses it.
    const forged = { ...card!, customer: { ...card!.customer, phone: other.phone, email: other.email } };
    const before = (await janes()).length;
    let refused = false;
    try {
      const result = await runAsSession(limitedSession, () => scoped(() => runAssistantAction(forged)));
      refused = !result.ok;
    } catch {
      refused = true; // the guard redirects
    }
    check("a forged card is refused, and nothing is created", refused && (await janes()).length === before);
  }

  console.log("\nA screenshot: kept for the reply that follows, then pinned");
  {
    const jpeg = cleanJpeg(new Uint8Array(await sharp({ create: { width: 40, height: 30, channels: 3, background: "#e07020" } }).jpeg().toBuffer()))!;
    const shot = jpegDataUrl(jpeg);
    const turn = (minutesAgo: number, question: string) => basePrisma.assistantTurn.create({
      data: { tenantId: T, userId: rep.id, source: "whatsapp", question, answer: "Pin it, or add its text?", createdAt: new Date(Date.now() - minutesAgo * 60_000) },
      select: { id: true },
    });
    const sent = await turn(5, "📎 (a screenshot)");
    await scoped(() => rememberImage(T, rep.id, sent.id, shot));
    check("the reply that follows gets the same picture back", (await scoped(() => carriedImage(T, rep.id, "whatsapp"))) === shot);
    check("…on that channel only", (await scoped(() => carriedImage(T, rep.id, "chat"))) === null);
    check("another workspace never sees it", (await runInTenantScope({ tenantId: OTHER_TENANT, system: false }, () => carriedImage(T, rep.id, "whatsapp"))) === null);

    // The card from the real builder: pinned, with THE picture in hand.
    const problems: string[] = [];
    const cards = await runAsSession(repSession, () => scoped(() =>
      resolveActions(rep, [{ type: "customer_note", contactId: id("c-ben"), text: "Screenshot: Ben's trade-in photo", pin: true, attachImage: true }], problems, null, shot)));
    const card = cards.find((c): c is Extract<ActionCard, { kind: "customer_note" }> => c.kind === "customer_note");
    check("the card carries the picture and says it pins the screenshot", card?.image === shot && /^Pin the screenshot to Ben/.test(card.title), JSON.stringify({ title: card?.title, problems }));
    const none: string[] = [];
    await runAsSession(repSession, () => scoped(() => resolveActions(rep, [{ type: "customer_note", contactId: id("c-ben"), text: "x", attachImage: true }], none, null, null)));
    check("no picture in hand: no card, and it says to send it again", /send the screenshot again/.test(none.join(" ")));

    const forged = await runAsSession(repSession, () => scoped(() => runAssistantAction({ ...card!, image: "data:image/png;base64,iVBORw0KGgo=" })));
    check("a forged picture is refused before anything is written", !forged.ok && forged.unchanged === true && (await basePrisma.communication.count({ where: { userId: rep.id } })) === 0, JSON.stringify(forged));
    const done = await runAsSession(repSession, () => scoped(() => runAssistantAction(card!)));
    const note = await basePrisma.communication.findFirst({ where: { userId: rep.id, contactId: id("c-ben") } });
    const pinned = note ? await basePrisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "TimelinePin" WHERE "kind" = 'communication' AND "itemId" = ${note.id}` : [];
    check("Confirm: the screenshot is on the customer's timeline, pinned", done.ok && note?.attachmentType === "image" && !!note.attachmentUrl && note.tenantId === T && Number(pinned[0]?.n ?? 0) === 1, JSON.stringify({ done, note }));
    check("…the very picture shown on the card", !!note?.attachmentUrl && (await readFile(path.join(process.cwd(), "storage", "uploads", note.attachmentUrl))).equals(Buffer.from(jpeg)));

    // Carried once: the reply that used it is not kept, so the message after that has no picture.
    await turn(2, "Pin it to Ben");
    check("the message after the reply gets no picture", (await scoped(() => carriedImage(T, rep.id, "whatsapp"))) === null);
    // Too late: the next message more than 30 minutes on.
    const late = await turn(45, "📎 (another)");
    await scoped(() => rememberImage(T, rep.id, late.id, shot));
    await basePrisma.assistantTurn.deleteMany({ where: { userId: rep.id, id: { not: late.id } } });
    check("a reply more than 30 minutes later gets no picture", (await scoped(() => carriedImage(T, rep.id, "whatsapp"))) === null);
    // The hourly clean-up.
    const kept = await basePrisma.assistantImage.count({ where: { userId: rep.id } });
    const removed = await pruneAssistantImages(T, new Date(Date.now() + 2 * 60 * 60_000));
    check("deleted after an hour", kept === 2 && removed >= 2 && (await basePrisma.assistantImage.count({ where: { userId: rep.id } })) === 0, `kept ${kept}, removed ${removed}`);
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
