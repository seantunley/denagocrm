/**
 * CUSTOMER STATEMENTS — PAYMENTS AND DEPOSITS on a real database (review of #924).
 *
 *   npm run test:quote-payments      (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * Drives the REAL server actions as a signed-in rep, with tenant enforcement on.
 * What a source test cannot show:
 *  - payments then a deposit (and a deposit corrected upward) can never take an
 *    invoice past paid — the deposit and the payments are one balance;
 *  - "1000,50" is R1 000,50; "1.000,50" is refused, never guessed;
 *  - the same payment form submitted twice — one after the other, or at the same
 *    instant — records the money once;
 *  - two different payments, or a payment and a deposit correction, racing for
 *    the last of the balance: exactly one wins;
 *  - a voided payment stays on the record and stops counting;
 *  - a trashed quote's number and amounts reach only a viewer with all-quote
 *    access (a CRM administrator); a rep with owned access is told only that
 *    trashed money exists;
 *  - a payment cannot point at another workspace's quote (composite key);
 *  - the proof of payment is filed WITH the deposit or not at all: the balance
 *    changing between staging the file and confirming the deposit (forced, not
 *    hoped for — the test holds the quote's lock until the deposit is queued on
 *    it) leaves no deposit, no Document row and no staged file; two staff
 *    recording the deposit at once leave exactly one of each.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * every row it creates (AuditEvent is append-only and is left, as everywhere).
 */
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import type { PermissionUser } from "../src/lib/permissions";
import { signFreshSession } from "../src/lib/session";
import { recordQuotePayment, voidQuotePayment } from "../src/app/actions/quotePayments";
import { correctDepositAmount, markDepositPaid } from "../src/app/actions/fulfilment";
import { loadContactStatement } from "../src/lib/accountStatementLoader";
import { deleteFile } from "../src/lib/storage";
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

const id = (what: string) => `qpay-${what}-${SFX}`;
const T = DEFAULT_TENANT_ID;
const OTHER_TENANT = id("tenant");
const rep: PermissionUser = { id: id("rep"), name: "Rep", email: `${id("rep")}@example.invalid`, role: "member" };
const colleague: PermissionUser = { id: id("colleague"), name: "Colleague", email: `${id("colleague")}@example.invalid`, role: "member" };
// A CRM administrator: the default role with workspace-wide quote access (sales managers lost it in migration 56).
const admin: PermissionUser = { id: id("admin"), name: "Admin", email: `${id("admin")}@example.invalid`, role: "member" };
const USERS = [rep, colleague, admin];
const CONTACT = id("contact");
const scoped = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: T, system: false }, fn);
// Quote numbers are globally unique; keep these far from anything the seed makes.
let nextNumber = 900_000_000 + Math.floor(Math.random() * 50_000_000);
const quoteIds: string[] = [];

async function sessionFor(user: PermissionUser): Promise<ActingSession> {
  return { cookieValue: await signFreshSession({ id: user.id, name: user.name, email: user.email, role: user.role, grants: "", sessionVersion: 0 }, 60, { tid: T }), label: user.name };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const payment = (amount: string, extra: Record<string, string> = {}) =>
  form({ amount, method: "eft", receivedAt: today, idempotencyKey: randomUUID(), ...extra });
/** The deliveries board's "Deposit paid" form: the amount and a proof-of-payment file. */
const depositWithProof = (amount: string) => {
  const data = form({ amount });
  data.set("file", new File([new Uint8Array([37, 80, 68, 70])], "pop.pdf", { type: "application/pdf" }));
  return data;
};

// Without a Blob token (CI, local), saveFile writes here — so a staged file is visible on disk.
const UPLOADS = path.join(process.cwd(), "storage", "uploads");
const uploads = async () => new Set(await readdir(UPLOADS).catch(() => [] as string[]));
const newFiles = async (before: Set<string>) => [...(await uploads())].filter((name) => !before.has(name));

/** Until some connection to this database is waiting on a lock — the deposit, queued on the quote's row. */
async function waitForLockWaiter(timeoutMs = 15_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const [{ n }] = await basePrisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** An accepted, invoiced quote for R100 000 (VAT inclusive), on the rep's customer. */
async function invoice(opts: { tenantId?: string; createdById?: string; deposit?: number; deleted?: boolean } = {}): Promise<{ id: string; number: number }> {
  const quoteId = id(`q${quoteIds.length}`);
  const tenantId = opts.tenantId ?? T;
  const number = nextNumber++;
  await basePrisma.quote.create({
    data: {
      id: quoteId,
      number,
      tenantId,
      status: "accepted",
      invoiceNumber: number,
      invoicedAt: new Date(),
      contactId: tenantId === T ? CONTACT : null,
      createdById: opts.createdById ?? rep.id,
      depositPaidAt: opts.deposit != null ? new Date() : null,
      depositPaidCents: opts.deposit ?? null,
      deletedAt: opts.deleted ? new Date() : null,
      items: { create: [{ tenantId, description: "Rover XL", qty: 1, unitPriceCents: 10_000_000, taxRatePct: 15 }] },
    },
  });
  quoteIds.push(quoteId);
  return { id: quoteId, number };
}

const live = async (quoteId: string) =>
  basePrisma.quotePayment.findMany({ where: { quoteId, voidedAt: null } });
const paidCents = async (quoteId: string) => (await live(quoteId)).reduce((sum, row) => sum + row.amountCents, 0);
const depositOf = async (quoteId: string) => (await basePrisma.quote.findUnique({ where: { id: quoteId } }))?.depositPaidCents ?? null;
const errorOf = (result: unknown) => (result && typeof result === "object" && "error" in result ? String((result as { error: unknown }).error) : "");
// An action that returns nothing on success resolves to `{}` (asActionResult); a refusal is `{ error }`.
const ok = (result: unknown) => Boolean(result && typeof result === "object" && !("error" in result));

async function seed() {
  await basePrisma.tenant.create({ data: { id: OTHER_TENANT, name: `Payments test ${SFX}`, slug: `qpay-test-${SFX}` } });
  await basePrisma.user.createMany({
    data: USERS.map((u) => ({ id: u.id, name: u.name, email: u.email, passwordHash: "test", role: "member", modules: "crm" })),
  });
  await basePrisma.$executeRaw`
    INSERT INTO "UserRole" ("id", "userId", "roleId", "tenantId") VALUES
      (gen_random_uuid()::text, ${rep.id}, 'role_sales_rep', ${T}),
      (gen_random_uuid()::text, ${colleague.id}, 'role_sales_rep', ${T}),
      (gen_random_uuid()::text, ${admin.id}, 'role_crm_admin', ${T})`;
  await basePrisma.$executeRaw`
    INSERT INTO "TenantMember" ("id", "tenantId", "userId") VALUES
      (${id("tm-rep")}, ${T}, ${rep.id}), (${id("tm-col")}, ${T}, ${colleague.id}), (${id("tm-admin")}, ${T}, ${admin.id})`;
  await basePrisma.contact.create({
    data: { id: CONTACT, tenantId: T, firstName: "Statement", lastName: `Customer${SFX}`, ownerId: rep.id, createdById: rep.id },
  });
}

async function cleanup() {
  // The proofs a successful deposit filed are real files on disk; remove them with their rows.
  for (const { storedName } of await basePrisma.document.findMany({ where: { quoteId: { in: quoteIds } }, select: { storedName: true } })) {
    await deleteFile(storedName).catch(() => {});
  }
  await basePrisma.quotePayment.deleteMany({ where: { quoteId: { in: quoteIds } } });
  await basePrisma.document.deleteMany({ where: { quoteId: { in: quoteIds } } });
  await basePrisma.quoteItem.deleteMany({ where: { quoteId: { in: quoteIds } } });
  await basePrisma.quote.deleteMany({ where: { id: { in: quoteIds } } });
  await basePrisma.auditLog.deleteMany({ where: { OR: [{ contactId: CONTACT }, { userId: { in: USERS.map((u) => u.id) } }] } });
  await basePrisma.contact.deleteMany({ where: { id: CONTACT } });
  await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${rep.id}, ${colleague.id}, ${admin.id})`;
  await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "userId" IN (${rep.id}, ${colleague.id}, ${admin.id})`;
  await basePrisma.user.deleteMany({ where: { id: { in: USERS.map((u) => u.id) } } });
  await basePrisma.tenant.deleteMany({ where: { id: OTHER_TENANT } });
}

async function main() {
  guardEnvironment();
  __setTenantEnforcingForTests(true);
  await seed();
  const asRep = await sessionFor(rep);
  const asAdmin = await sessionFor(admin);
  const act = <R>(session: ActingSession, fn: () => Promise<R>) => runAsSession(session, () => scoped(fn));

  console.log("\nDeposit and payments are ONE balance (review #924, finding 1)");
  {
    const q = await invoice();
    const paid = await act(asRep, () => recordQuotePayment(q.id, payment("80000")));
    check("R80 000 recorded against a R100 000 invoice", ok(paid) && (await paidCents(q.id)) === 8_000_000, errorOf(paid));
    const deposit = await act(asRep, () => markDepositPaid(q.id, depositWithProof("30000")));
    check("…then a R30 000 deposit is refused: it would take the invoice past paid", /past paid/.test(errorOf(deposit)) && (await depositOf(q.id)) === null, errorOf(deposit));
    check("…and the refusal filed no proof of payment", (await basePrisma.document.count({ where: { quoteId: q.id } })) === 0);

    const q2 = await invoice({ deposit: 1_000_000 });
    await act(asRep, () => recordQuotePayment(q2.id, payment("85000")));
    const up = await act(asRep, () => correctDepositAmount(q2.id, form({ amount: "20000" })));
    check("a deposit corrected UP past what the payments leave is refused", /past paid/.test(errorOf(up)) && (await depositOf(q2.id)) === 1_000_000, errorOf(up));
    const fits = await act(asRep, () => correctDepositAmount(q2.id, form({ amount: "15000" })));
    check("…corrected to exactly what is left is accepted", ok(fits) && (await depositOf(q2.id)) === 1_500_000, errorOf(fits));
    const over = await act(asRep, () => recordQuotePayment(q2.id, payment("0,01")));
    check("…and the invoice is now paid: not one cent more", /Nothing is owing/.test(errorOf(over)), errorOf(over));
  }

  console.log("\nAmounts typed the South African way (finding 2)");
  {
    const q = await invoice();
    const comma = await act(asRep, () => recordQuotePayment(q.id, payment("1000,50")));
    check('"1000,50" is R1 000,50 — not R100 050', ok(comma) && (await paidCents(q.id)) === 100_050, `${errorOf(comma)} ${await paidCents(q.id)}`);
    const spaced = await act(asRep, () => recordQuotePayment(q.id, payment("1 000,50")));
    check('"1 000,50" is R1 000,50', ok(spaced) && (await paidCents(q.id)) === 200_100, errorOf(spaced));
    const european = await act(asRep, () => recordQuotePayment(q.id, payment("1.000,50")));
    check('"1.000,50" is refused, never guessed', /isn't a clear amount/.test(errorOf(european)) && (await paidCents(q.id)) === 200_100, errorOf(european));
    const depositQuote = await invoice({ deposit: 1_000_000 });
    const deposit = await act(asRep, () => correctDepositAmount(depositQuote.id, form({ amount: "5 000,50" })));
    check('the deposit form reads amounts the same way: "5 000,50" is R5 000,50', ok(deposit) && (await depositOf(depositQuote.id)) === 500_050, `${errorOf(deposit)} ${await depositOf(depositQuote.id)}`);
    const guessed = await act(asRep, () => correctDepositAmount(depositQuote.id, form({ amount: "5.000,50" })));
    check('…and refuses "5.000,50" without changing it', /isn't a clear amount/.test(errorOf(guessed)) && (await depositOf(depositQuote.id)) === 500_050, errorOf(guessed));
  }

  console.log("\nThe same payment form submitted twice (finding 3)");
  {
    const q = await invoice();
    const key = randomUUID();
    const first = await act(asRep, () => recordQuotePayment(q.id, payment("10000", { idempotencyKey: key })));
    const retry = await act(asRep, () => recordQuotePayment(q.id, payment("10000", { idempotencyKey: key })));
    check("a retry after the first succeeded records nothing new", ok(first) && ok(retry) && (await live(q.id)).length === 1, errorOf(retry));
    check("…and says so", /already recorded/.test(String((retry as { success?: string }).success)));

    const atOnce = randomUUID();
    const both = await Promise.all([
      act(asRep, () => recordQuotePayment(q.id, payment("10000", { idempotencyKey: atOnce }))),
      act(asRep, () => recordQuotePayment(q.id, payment("10000", { idempotencyKey: atOnce }))),
    ]);
    check("two submissions of one form at the same instant: recorded once", both.every(ok) && (await live(q.id)).length === 2 && (await paidCents(q.id)) === 2_000_000, JSON.stringify(both));
    const reused = await act(asRep, () => recordQuotePayment(q.id, payment("5000", { idempotencyKey: key })));
    check("a used form cannot record a DIFFERENT amount", /already used/.test(errorOf(reused)) && (await live(q.id)).length === 2, errorOf(reused));
    const ref = await act(asRep, () => recordQuotePayment(q.id, payment("1000", { reference: "FNB 4471" })));
    const sameRef = await act(asRep, () => recordQuotePayment(q.id, payment("1000", { reference: "fnb 4471" })));
    check("the same bank reference twice is the same money twice: refused", ok(ref) && /already recorded on this invoice/.test(errorOf(sameRef)), errorOf(sameRef));
    const noKey = await act(asRep, () => recordQuotePayment(q.id, form({ amount: "1000", method: "eft", receivedAt: today })));
    check("a submission without the form's key is refused", /out of date/.test(errorOf(noKey)), errorOf(noKey));
  }

  console.log("\nRacing for the last of the balance");
  {
    const q = await invoice({ deposit: 2_000_000 });
    const race = await Promise.all([
      act(asRep, () => recordQuotePayment(q.id, payment("50000"))),
      act(asRep, () => recordQuotePayment(q.id, payment("50000"))),
    ]);
    check("two R50 000 payments for the last R80 000: exactly one is recorded", race.filter(ok).length === 1 && (await paidCents(q.id)) === 5_000_000, JSON.stringify(race));
    const mixed = await Promise.all([
      act(asRep, () => recordQuotePayment(q.id, payment("25000"))),
      act(asRep, () => correctDepositAmount(q.id, form({ amount: "45000" }))),
    ]);
    const total = (await paidCents(q.id)) + ((await depositOf(q.id)) ?? 0);
    check("a payment and a deposit correction at once: never past paid", mixed.filter(ok).length === 1 && total <= 10_000_000, `${JSON.stringify(mixed)} total=${total}`);
  }

  console.log("\nVoiding");
  {
    const q = await invoice();
    await act(asRep, () => recordQuotePayment(q.id, payment("40000")));
    const [row] = await live(q.id);
    const voided = await act(asRep, () => voidQuotePayment(q.id, row.id, form({ reason: "Captured twice" })));
    const after = await basePrisma.quotePayment.findUnique({ where: { id: row.id } });
    check("a voided payment is kept, marked, and stops counting", ok(voided) && after?.voidedAt !== null && after?.voidReason === "Captured twice" && after?.voidedByName === rep.name && (await paidCents(q.id)) === 0, errorOf(voided));
    const again = await act(asRep, () => voidQuotePayment(q.id, row.id, form({ reason: "Again" })));
    check("…and cannot be voided twice", /already been voided/.test(errorOf(again)));
    const refill = await act(asRep, () => recordQuotePayment(q.id, payment("100000")));
    check("…its amount is owing again", ok(refill), errorOf(refill));
  }

  console.log("\nA trashed quote's figures (finding 4)");
  {
    const trashed = await invoice({ createdById: colleague.id, deposit: 777_700, deleted: true });
    const fmt = (cents: number) => `R${(cents / 100).toFixed(2)}`;
    const forRep = await act(asRep, () => loadContactStatement(rep, CONTACT, fmt));
    const repWarnings = forRep.kind === "ok" ? forRep.statement.warnings.join(" | ") : "";
    check("a rep with owned access gets the statement", forRep.kind === "ok", forRep.kind);
    check("…told trashed money exists, without its number or amount", /in the trash/.test(repWarnings) && !repWarnings.includes(`Q-${trashed.number}`) && !repWarnings.includes("7777.00"), repWarnings);
    const forAdmin = await act(asAdmin, () => loadContactStatement(admin, CONTACT, fmt));
    const adminWarnings = forAdmin.kind === "ok" ? forAdmin.statement.warnings.join(" | ") : forAdmin.kind;
    check("an administrator who can see all quotes is given the details", adminWarnings.includes(`Q-${trashed.number}`) && adminWarnings.includes("7777.00"), adminWarnings);
  }

  console.log("\nThe proof of payment is filed with the deposit, or not at all (recheck of #924)");
  {
    const fits = await invoice();
    const recorded = await act(asRep, () => markDepositPaid(fits.id, depositWithProof("20000")));
    const filed = await basePrisma.document.findMany({ where: { quoteId: fits.id } });
    check("a deposit that fits is recorded with its proof, together", ok(recorded) && (await depositOf(fits.id)) === 2_000_000 && filed.length === 1 && filed[0].tag === "pop" && filed[0].tenantId === T, errorOf(recorded));

    // Force the race: hold the quote's row lock, let the deposit stage its proof
    // and queue on that lock, record a payment in the meantime, then let go.
    const raced = await invoice();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${raced.id} AND "tenantId" = ${T} FOR UPDATE`;
      await gate;
      await tx.quotePayment.create({
        data: { tenantId: T, quoteId: raced.id, amountCents: 8_000_000, receivedAt: new Date(), method: "eft", createdByName: "Someone else", idempotencyKey: randomUUID() },
      });
    }, { timeout: 30_000, maxWait: 10_000 });
    const before = await uploads();
    const pending = act(asRep, () => markDepositPaid(raced.id, depositWithProof("30000")));
    const queued = await waitForLockWaiter();
    const stagedWhileWaiting = await newFiles(before);
    release();
    await holder;
    const result = await pending;
    check("the deposit queued on the quote's lock with its proof already staged", queued && stagedWhileWaiting.length === 1, `queued=${queued} staged=${stagedWhileWaiting.length}`);
    check("…a R80 000 payment landed meanwhile, so the R30 000 deposit is refused", /past paid/.test(errorOf(result)) && (await depositOf(raced.id)) === null, errorOf(result));
    check("…and no proof-of-payment document exists for it, live or trashed", (await basePrisma.document.count({ where: { quoteId: raced.id } })) === 0);
    check("…and the staged file is gone", (await newFiles(before)).length === 0, (await newFiles(before)).join(","));

    // Two staff recording the same deposit at once.
    const both = await invoice();
    const beforeBoth = await uploads();
    const asColleagueAdmin = await sessionFor(admin);
    const results = await Promise.all([
      act(asRep, () => markDepositPaid(both.id, depositWithProof("10000"))),
      act(asColleagueAdmin, () => markDepositPaid(both.id, depositWithProof("15000"))),
    ]);
    const proofs = await basePrisma.document.findMany({ where: { quoteId: both.id } });
    const winner = results.findIndex(ok);
    check("two staff recording the deposit at once: exactly one is recorded", results.filter(ok).length === 1 && /already recorded/.test(results.map(errorOf).join(" ")), JSON.stringify(results));
    check("…with exactly one proof, and the deposit is the winner's amount", proofs.length === 1 && (await depositOf(both.id)) === (winner === 0 ? 1_000_000 : 1_500_000), `${proofs.length} ${await depositOf(both.id)}`);
    check("…and only the winner's file remains", (await newFiles(beforeBoth)).length === 1 && (await newFiles(beforeBoth))[0] === proofs[0]?.storedName, (await newFiles(beforeBoth)).join(","));
  }

  console.log("\nWorkspaces");
  {
    const foreign = await invoice({ tenantId: OTHER_TENANT });
    let refused = false;
    try {
      await basePrisma.quotePayment.create({
        data: { tenantId: T, quoteId: foreign.id, amountCents: 100, receivedAt: new Date(), method: "eft", createdByName: "x", idempotencyKey: randomUUID() },
      });
    } catch {
      refused = true;
    }
    check("a payment in this workspace cannot point at another workspace's quote", refused);
    // The access gate says no by redirecting, which the harness surfaces as a throw.
    const reach = await act(asRep, () => recordQuotePayment(foreign.id, payment("100"))).catch((error: Error) => ({ error: error.message }));
    check("…and the action will not reach it", !ok(reach) && (await live(foreign.id)).length === 0, errorOf(reach));
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
