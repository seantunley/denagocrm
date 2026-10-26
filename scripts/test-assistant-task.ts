/**
 * DAX JOB SHEETS on a real database (roadmap Phase 1, 2026-10-26).
 *
 *   npm run test:assistant-task      (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * What a source test cannot show:
 *  - a sheet is written, corrected and read back through the SCOPED client, with enforcement on;
 *  - two answers writing the same sheet at once (WhatsApp and the CRM): exactly one wins, the other is told —
 *    the row lock and the version check together;
 *  - an id the person may no longer open is blanked when the sheet is read; another person's or another
 *    workspace's sheet is never found, and RLS refuses it under a NOBYPASSRLS role;
 *  - the sheet fills a quote card (customer, lines, fees) and refuses a second quote for it;
 *  - a confirmed quote is recorded on the sheet once; 14 days quiet closes it; Reopen brings it back.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates.
 * The model is never called.
 */
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import type { PermissionUser } from "../src/lib/permissions";
import { applyTaskUpdate, openTasks, recordTaskProgress, setTaskStatus, tasksForAskPage } from "../src/lib/assistantTask";
import { keepIds, parseTaskUpdate, type TaskView } from "../src/lib/assistantTaskRules";
import { resolveActions } from "../src/lib/crmAssistant";
import { saveQuoteDraft } from "../src/app/actions/quotes";
import { signFreshSession } from "../src/lib/session";
import { runAsSession, type ActingSession } from "./harness/actingSession";
import { randomBytes } from "node:crypto";

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

const id = (what: string) => `asst-task-${what}-${SFX}`;
const T = DEFAULT_TENANT_ID;
const rep: PermissionUser = { id: id("rep"), name: "Rep", email: `${id("rep")}@example.invalid`, role: "member" };
const other: PermissionUser = { id: id("other"), name: "Other", email: `${id("other")}@example.invalid`, role: "member" };
const C = { anna: id("c-anna"), notHis: id("c-nothis") };
const P = { rover: id("p-rover") };
const ROLE_NAME = `task_rls_${SFX}`;
const OTHER_TENANT = id("tenant");
const scoped = <R>(fn: () => Promise<R>, tenantId = T) => runInTenantScope({ tenantId, system: false }, fn);
const PRODUCT = `Task Rover XL ${SFX}`;

async function seed() {
  // A second workspace of its own, so the cross-workspace checks never depend on what else the database holds.
  await basePrisma.tenant.create({ data: { id: OTHER_TENANT, name: `Task test ${SFX}`, slug: `task-test-${SFX}` } });
  await basePrisma.user.createMany({
    data: [rep, other].map((u) => ({ id: u.id, name: u.name, email: u.email, passwordHash: "test", role: "member", modules: "crm" })),
  });
  await basePrisma.$executeRaw`
    INSERT INTO "UserRole" ("id", "userId", "roleId", "tenantId") VALUES
      (gen_random_uuid()::text, ${rep.id}, 'role_sales_rep', ${T}),
      (gen_random_uuid()::text, ${other.id}, 'role_sales_rep', ${T})`;
  await basePrisma.contact.createMany({
    data: [
      { id: C.anna, tenantId: T, firstName: "Anna", lastName: `Jacobs${SFX}`, ownerId: rep.id, createdById: rep.id },
      // Somebody else's customer: rep cannot open it.
      { id: C.notHis, tenantId: T, firstName: "Anna", lastName: `Jacobsen${SFX}`, ownerId: other.id, createdById: other.id },
    ],
  });
  await basePrisma.product.create({
    data: { id: P.rover, tenantId: T, name: PRODUCT, basePriceCents: 23_500_000, colors: { create: [{ tenantId: T, name: "White" }, { tenantId: T, name: "Gray" }] } },
  });
  // Each person belongs to the workspace, so a signed-in save (saveQuoteDraft) resolves it as theirs.
  await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id", "tenantId", "userId") VALUES (${id("tm-rep")}, ${T}, ${rep.id}), (${id("tm-other")}, ${T}, ${other.id})`;
}

/** A signed session for a seeded person, as the harness signs one (scripts/harness/seed.ts mintSession). */
async function sessionFor(user: PermissionUser): Promise<ActingSession> {
  return { cookieValue: await signFreshSession({ id: user.id, name: user.name ?? "", email: user.email ?? "", role: user.role, grants: "", sessionVersion: 0 }, 60, { tid: T }), label: user.name ?? user.id };
}

async function cleanup() {
  await basePrisma.$executeRawUnsafe(`DROP OWNED BY "${ROLE_NAME}"`).catch(() => {});
  await basePrisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${ROLE_NAME}"`).catch(() => {});
  await basePrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS task_test_fail ON "AssistantTask"`).catch(() => {});
  await basePrisma.assistantTask.deleteMany({ where: { userId: { in: [rep.id, other.id] } } });
  await basePrisma.assistantTurn.deleteMany({ where: { userId: { in: [rep.id, other.id] } } });
  // Spent confirm keys are the saver's AssistantPendingAction rows.
  await basePrisma.assistantPendingAction.deleteMany({ where: { userId: { in: [rep.id, other.id] } } });
  const quotes = (await basePrisma.quote.findMany({ where: { createdById: { in: [rep.id, other.id] } }, select: { id: true } })).map((q) => q.id);
  await basePrisma.quoteItem.deleteMany({ where: { quoteId: { in: quotes } } });
  await basePrisma.quoteFee.deleteMany({ where: { quoteId: { in: quotes } } });
  await basePrisma.quote.deleteMany({ where: { id: { in: quotes } } });
  await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${rep.id}, ${other.id})`;
  // The real saves wrote the customers' history (AuditLog — not the append-only AuditEvent trail).
  await basePrisma.auditLog.deleteMany({ where: { OR: [{ contactId: { in: Object.values(C) } }, { userId: { in: [rep.id, other.id] } }] } });
  await basePrisma.productColor.deleteMany({ where: { productId: P.rover } });
  await basePrisma.product.deleteMany({ where: { id: P.rover } });
  await basePrisma.contact.deleteMany({ where: { id: { in: Object.values(C) } } });
  await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "userId" IN (${rep.id}, ${other.id})`;
  await basePrisma.user.deleteMany({ where: { id: { in: [rep.id, other.id] } } });
  await basePrisma.tenant.deleteMany({ where: { id: OTHER_TENANT } });
}

const sheet = (over: Record<string, unknown> = {}) =>
  parseTaskUpdate({
    kind: "quote", title: `Quote for Anna Jacobs${SFX}: Rover XL`, contactId: C.anna,
    lines: [{ product: PRODUCT, qty: 1, colour: "grey" }], fees: [{ label: "Delivery — Hermanus", amount: 6500, delivery: true }],
    confirmed: ["Rover XL", "delivery R6 500"], missing: ["colour"], next: "Confirm the colour", ...over,
  })!;
const seen = new Set([`contact:${C.anna}`]);

async function main() {
  guardEnvironment();
  __setTenantEnforcingForTests(true);
  await seed();

  console.log("\nWriting and reading a sheet");
  let loaded: TaskView[] = [];
  let taskId = "";
  {
    const written = await scoped(() => applyTaskUpdate(rep, keepIds(sheet(), seen), []));
    check("a new sheet is written through the scoped client", written?.ok === true && written.created, JSON.stringify(written));
    taskId = written?.ok ? written.id : "";
    const row = await basePrisma.assistantTask.findUnique({ where: { id: taskId } });
    check("…stamped with the workspace and the person", row?.tenantId === T && row.userId === rep.id && row.version === 0);
    loaded = await scoped(() => openTasks(rep));
    check("it is the person's open sheet, with its customer id", loaded.length === 1 && loaded[0].id === taskId && loaded[0].contactId === C.anna, JSON.stringify(loaded.map((t) => t.contactId)));
    const dropped = await scoped(() => applyTaskUpdate(rep, keepIds(sheet({ contactId: C.notHis, title: `Unseen${SFX}` }), seen), []));
    const droppedRow = dropped?.ok ? await basePrisma.assistantTask.findUnique({ where: { id: dropped.id } }) : null;
    check("an id this turn's lookups did not return is never stored", droppedRow !== null && droppedRow.contactId === null, String(droppedRow?.contactId));
    if (dropped?.ok) await basePrisma.assistantTask.delete({ where: { id: dropped.id } });
    check("another person in the same workspace does not see it", (await scoped(() => openTasks(other))).length === 0);
  }

  console.log("\nA correction, and two answers at once");
  {
    const fixed = await scoped(() => applyTaskUpdate(rep, keepIds(sheet({ id: taskId, lines: [{ product: PRODUCT, qty: 1, colour: "White" }] }), seen), loaded));
    const row = await basePrisma.assistantTask.findUnique({ where: { id: taskId } });
    const details = row?.details as { lines?: { colour?: string }[]; fees?: unknown[] };
    check("grey → white changes that line; the fee stays", fixed?.ok === true && details.lines?.[0]?.colour === "White" && details.fees?.length === 1 && row?.version === 1, JSON.stringify(details));
    const stale = await scoped(() => applyTaskUpdate(rep, sheet({ id: taskId, title: "Stale write" }), loaded));
    check("an answer that read the older version does not overwrite the newer one", stale?.ok === false && (await basePrisma.assistantTask.findUnique({ where: { id: taskId } }))?.title !== "Stale write");
    const now = await scoped(() => openTasks(rep));
    const both = await Promise.all([
      scoped(() => applyTaskUpdate(rep, parseTaskUpdate({ kind: "quote", id: taskId, next: "From WhatsApp" })!, now)),
      scoped(() => applyTaskUpdate(rep, parseTaskUpdate({ kind: "quote", id: taskId, next: "From the CRM" })!, now)),
    ]);
    const after = await basePrisma.assistantTask.findUnique({ where: { id: taskId } });
    check("WhatsApp and the CRM at once: exactly one write lands, the other is told", both.filter((w) => w?.ok).length === 1 && both.filter((w) => w?.ok === false).length === 1 && after?.version === 2, JSON.stringify(both.map((w) => w?.ok)));
    const othersLoaded = await scoped(() => openTasks(other));
    const othersSheet = await scoped(() => applyTaskUpdate(other, sheet({ id: taskId, title: `Hijack${SFX}` }), othersLoaded));
    check("another person naming this sheet's id starts their own — never reaches this one", othersSheet?.ok === true && othersSheet.created && othersSheet.id !== taskId && (await basePrisma.assistantTask.findUnique({ where: { id: taskId } }))?.title !== `Hijack${SFX}`);
    loaded = await scoped(() => openTasks(rep));
  }

  console.log("\nThe sheet fills the quote card");
  {
    const sheetNow = { id: taskId, kind: "quote" as const, contactId: C.anna, leadId: null, quoteId: null, details: loaded[0].details };
    const problems: string[] = [];
    const cards = await scoped(() => resolveActions(rep, [{ type: "quote_build", lines: [{ product: PRODUCT, qty: 3 }] }], problems, sheetNow));
    const card = cards[0] as Extract<(typeof cards)[number], { kind: "quote_build" }> | undefined;
    check("customer, lines and fees come from the sheet — not what the model re-typed", card?.kind === "quote_build" && card.contactId === C.anna && card.lines[0]?.qty === 1 && card.lines[0]?.colour === "White" && card.fees?.[0]?.amountCents === 650_000, JSON.stringify({ card, problems }));
    check("the card carries the sheet's id, so Confirm can record the quote there", card?.taskId === taskId);
    const empty = await scoped(() => resolveActions(rep, [{ type: "quote_build" }], [], { ...sheetNow, details: {} }));
    check("no lines anywhere: no card", empty.length === 0);
  }

  console.log("\nOne sheet, one quote — made and linked in ONE transaction (review of #918)");
  let builtId = "";
  {
    const repSession = await sessionFor(rep);
    const otherSession = await sessionFor(other);
    const save = (session: ActingSession, contactId: string, extra: Record<string, unknown>) =>
      runAsSession(session, () => scoped(() => saveQuoteDraft({
        contactId, terms: "", intent: "draft",
        items: [{ description: PRODUCT, qty: 1, unitPriceCents: 23_500_000, productId: P.rover, colorPreference: "White", discountPct: 0 }],
        ...extra,
      })));
    const key = () => `qk_${randomBytes(16).toString("hex")}`;
    const quotesSince = (since: Date) => basePrisma.quote.count({ where: { createdById: { in: [rep.id, other.id] }, createdAt: { gte: since } } });

    // Two cards for the same sheet, each with its OWN confirm key, confirmed one after the other.
    let since = new Date();
    const first = await save(repSession, C.anna, { confirmKey: key(), assistantTaskId: taskId });
    const second = await save(repSession, C.anna, { confirmKey: key(), assistantTaskId: taskId });
    builtId = first.ok ? first.quote.id : "";
    const row = await basePrisma.assistantTask.findUnique({ where: { id: taskId } });
    check("two cards, two keys, one sheet: ONE quote", (await quotesSince(since)) === 1 && first.ok, JSON.stringify({ first, second }));
    check("…the second Confirm gets the sheet's quote back, not a new one", !second.ok && second.repeated === true && second.quote?.id === builtId, JSON.stringify(second));
    check("…and the sheet is linked to it in the same save, with the step noted", row?.quoteId === builtId && (row?.steps as { done: string[] }).done.some((s) => /^Draft quote Q-\d+ created$/.test(s)), String(row?.quoteId));

    // The same, at the same moment (WhatsApp and the CRM): the sheet's row lock lets one through.
    const raced = await scoped(() => applyTaskUpdate(rep, keepIds(sheet({ title: `Raced${SFX}` }), seen), []));
    const racedId = raced?.ok ? raced.id : "";
    since = new Date();
    const both = await Promise.all([
      save(repSession, C.anna, { confirmKey: key(), assistantTaskId: racedId }),
      save(repSession, C.anna, { confirmKey: key(), assistantTaskId: racedId }),
    ]);
    const made = both.filter((r) => r.ok);
    const linkedTo = (await basePrisma.assistantTask.findUnique({ where: { id: racedId } }))?.quoteId;
    check("two Confirms at once for one sheet: ONE quote, and the other is told it exists", (await quotesSince(since)) === 1 && made.length === 1 && both.some((r) => !r.ok && r.repeated && r.quote?.id === linkedTo), JSON.stringify(both));

    // The link fails AFTER the quote was written: the whole save is undone — no orphan quote, the key unspent.
    const doomed = await scoped(() => applyTaskUpdate(rep, keepIds(sheet({ title: `Doomed${SFX}` }), seen), []));
    const doomedId = doomed?.ok ? doomed.id : "";
    await basePrisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION task_test_fail() RETURNS trigger AS $$ BEGIN
      IF NEW."id" = '${doomedId}' THEN RAISE EXCEPTION 'simulated job sheet failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await basePrisma.$executeRawUnsafe(`CREATE TRIGGER task_test_fail BEFORE UPDATE ON "AssistantTask" FOR EACH ROW EXECUTE FUNCTION task_test_fail()`);
    const doomedKey = key();
    since = new Date();
    let threw = false;
    try {
      await save(repSession, C.anna, { confirmKey: doomedKey, assistantTaskId: doomedId });
    } catch {
      threw = true;
    } finally {
      await basePrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS task_test_fail ON "AssistantTask"`);
      await basePrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS task_test_fail()`);
    }
    const spent = await basePrisma.assistantPendingAction.count({ where: { id: doomedKey } });
    check("the sheet can't be linked: the save fails, and NO quote is left behind", threw && (await quotesSince(since)) === 0 && spent === 0, JSON.stringify({ threw, spent }));
    const retry = await save(repSession, C.anna, { confirmKey: doomedKey, assistantTaskId: doomedId });
    check("…so Confirm again (same card) simply makes it, once, linked", retry.ok && (await quotesSince(since)) === 1 && (await basePrisma.assistantTask.findUnique({ where: { id: doomedId } }))?.quoteId === (retry.ok ? retry.quote.id : "?"));

    // Somebody else naming this sheet on their own quote: refused, nothing made.
    since = new Date();
    const forged = await save(otherSession, C.notHis, { confirmKey: key(), assistantTaskId: taskId });
    check("a card naming somebody else's sheet makes nothing and leaves the sheet alone", !forged.ok && !forged.repeated && (await quotesSince(since)) === 0 && (await basePrisma.assistantTask.findUnique({ where: { id: taskId } }))?.quoteId === builtId, JSON.stringify(forged));

    // A card with no sheet keeps the confirm-key rule: the same key twice is one quote.
    const plainKey = key();
    since = new Date();
    const p1 = await save(repSession, C.anna, { confirmKey: plainKey });
    const p2 = await save(repSession, C.anna, { confirmKey: plainKey });
    check("no sheet: the confirm key still makes it once", p1.ok && !p2.ok && p2.repeated === true && !p2.quote && (await quotesSince(since)) === 1);

    await scoped(() => recordTaskProgress(other.id, taskId, { done: "forged" }));
    check("a step note naming somebody else's sheet changes nothing on it", !JSON.stringify((await basePrisma.assistantTask.findUnique({ where: { id: taskId } }))?.steps).includes("forged"));
    for (const t of [racedId, doomedId]) await scoped(() => setTaskStatus(rep.id, t, "closed"));
    await basePrisma.assistantTask.deleteMany({ where: { id: { in: [racedId, doomedId] } } });

    loaded = await scoped(() => openTasks(rep));
    check("read back, the sheet shows the quote as the CRM holds it", loaded[0]?.quote?.lines[0]?.includes("(White)") === true, JSON.stringify(loaded[0]?.quote));
    const sheetNow = { id: taskId, kind: "quote" as const, contactId: C.anna, leadId: null, quoteId: builtId, details: loaded[0].details };
    const problems: string[] = [];
    const again = await scoped(() => resolveActions(rep, [{ type: "quote_build" }], problems, sheetNow));
    check("one sheet, one quote: a second quote_build is refused, and says why", again.length === 0 && /already has its quote/.test(problems[0] ?? ""), JSON.stringify(problems));
    const change = await scoped(() => resolveActions(rep, [{ type: "quote_change", lines: [{ colour: "Gray" }] }], [], sheetNow));
    const c = change[0] as Extract<(typeof change)[number], { kind: "quote_change" }> | undefined;
    check("a correction after the quote exists is a quote_change on the sheet's quote", c?.kind === "quote_change" && c.quoteId === builtId && c.taskId === taskId, JSON.stringify(change));
    const relines = await scoped(() => applyTaskUpdate(rep, sheet({ id: taskId, lines: [{ product: "Nomad", qty: 4 }] }), loaded));
    const kept = (await basePrisma.assistantTask.findUnique({ where: { id: taskId } }))?.details as { lines?: { colour?: string; qty: number }[] };
    check("once there is a quote, the model cannot rewrite the sheet's lines", relines?.ok === true && kept.lines?.[0]?.qty === 1, JSON.stringify(kept.lines));
  }

  console.log("\nAccess re-checked on every load");
  {
    await basePrisma.contact.update({ where: { id: C.anna }, data: { ownerId: other.id, createdById: other.id } });
    await basePrisma.quote.update({ where: { id: builtId }, data: { createdById: other.id } });
    const now = await scoped(() => openTasks(rep));
    check("a customer (and quote) handed to someone else disappear from the sheet the person reads", now[0]?.contactId === null && now[0].quote === null, JSON.stringify({ c: now[0]?.contactId, q: now[0]?.quote }));
    check("…but the sheet still knows it HAS a quote, so it never builds a second", now[0]?.quoteId === builtId);
    await basePrisma.contact.update({ where: { id: C.anna }, data: { ownerId: rep.id, createdById: rep.id } });
    await basePrisma.quote.update({ where: { id: builtId }, data: { createdById: rep.id } });
  }

  console.log("\nAnother workspace, and RLS itself");
  {
    const otherTenant = OTHER_TENANT;
    {
      const there = await scoped(() => openTasks(rep), otherTenant);
      check("the same person acting in another workspace sees none of these sheets", there.length === 0);
      // The policy, under a role that cannot bypass it (production connects as such a role).
      await basePrisma.$executeRawUnsafe(`CREATE ROLE "${ROLE_NAME}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await basePrisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${ROLE_NAME}"`);
      await basePrisma.$executeRawUnsafe(`GRANT SELECT, INSERT ON "AssistantTask" TO "${ROLE_NAME}"`);
      const asRole = (tenant: string, sql: string) =>
        basePrisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE "${ROLE_NAME}"`);
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, true), set_config('app.bypass_rls', 'off', true)`, tenant);
          return tx.$queryRawUnsafe<{ n: number }[]>(sql);
        });
      const own = await asRole(T, `SELECT count(*)::int n FROM "AssistantTask" WHERE "userId" = '${rep.id}'`);
      const foreign = await asRole(otherTenant, `SELECT count(*)::int n FROM "AssistantTask" WHERE "userId" = '${rep.id}'`);
      check("RLS: its own workspace reads the sheet…", own[0].n === 1, JSON.stringify(own));
      check("…another workspace reads nothing", foreign[0].n === 0, JSON.stringify(foreign));
      let refused = false;
      try {
        await asRole(otherTenant, `INSERT INTO "AssistantTask" ("id","tenantId","userId","kind","title","details","steps") VALUES ('${id("x")}','${T}','${rep.id}','quote','x','{}','{}') RETURNING 1 n`);
      } catch { refused = true; }
      check("…and cannot write a sheet into this one", refused);
    }
  }

  console.log("\nClosing on its own after 14 days, and Reopen");
  {
    await basePrisma.assistantTask.update({ where: { id: taskId }, data: { updatedAt: new Date(Date.now() - 15 * 86_400_000) } });
    check("14 days without activity: no longer in front of each question", (await scoped(() => openTasks(rep))).length === 0);
    const page = await scoped(() => tasksForAskPage(rep.id));
    check("…but still on the Ask page, as closed", page.find((t) => t.id === taskId)?.status === "closed");
    check("somebody else cannot reopen it", (await scoped(() => setTaskStatus(other.id, taskId, "open"))) === null);
    await scoped(() => setTaskStatus(rep.id, taskId, "open"));
    check("Reopen brings it back for another 14 days", (await scoped(() => openTasks(rep)))[0]?.id === taskId);
    await scoped(() => setTaskStatus(rep.id, taskId, "closed"));
    const closed = await basePrisma.assistantTask.findUnique({ where: { id: taskId } });
    check("Close takes it out, and closing is not activity", closed?.status === "closed" && closed.closedAt !== null && (await scoped(() => openTasks(rep))).length === 0);
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
