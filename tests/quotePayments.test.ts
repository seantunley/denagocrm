import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/*
 * Customer statements (2026-10-28): payments after the deposit are QuotePayment
 * rows, and a statement lists every invoice less every deposit and payment. These
 * pin the parts a refactor could quietly loosen — the table's tenant isolation,
 * who may record money, one balance for deposit + payments under one lock, a
 * resubmitted form recording once, a wrong entry voided not deleted, and a
 * statement that never pools workspaces, prints with an invoice missing, or shows
 * a trashed quote's figures to someone who cannot read it. The behaviour itself
 * runs against a real database in scripts/test-quote-payments.ts.
 */

const read = (path: string) => readFileSync(path, "utf8");
const MIGRATION = "prisma/migrations/20261028120000_quote_payments/migration.sql";
const IDEMPOTENCY_MIGRATION = "prisma/migrations/20261028130000_quote_payment_idempotency/migration.sql";

test("QuotePayment is a tenant-isolated table, additive and re-runnable", () => {
  const sql = read(MIGRATION);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "QuotePayment" \(/);
  assert.match(sql, /"tenantId" TEXT NOT NULL,/);
  assert.match(sql, /CONSTRAINT "QuotePayment_amountCents_check" CHECK \("amountCents" > 0\)/);
  // Same workspace as its quote — a cross-tenant quoteId cannot be stored.
  assert.match(sql, /FOREIGN KEY \("tenantId", "quoteId"\) REFERENCES "Quote"\("tenantId", "id"\)/);
  assert.match(sql, /ALTER TABLE "QuotePayment" ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /DROP POLICY IF EXISTS "QuotePayment_tenant_isolation" ON "QuotePayment";/);
  assert.match(sql, /CREATE POLICY "QuotePayment_tenant_isolation" ON "QuotePayment"/);
  assert.match(sql, /ALTER TABLE "QuotePayment" FORCE ROW LEVEL SECURITY;/);
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|ALTER COLUMN|TRUNCATE|DELETE FROM/i);
});

test("a payment form's one-time key is unique per workspace in the database", () => {
  const sql = read(IDEMPOTENCY_MIGRATION);
  assert.match(sql, /ALTER TABLE "QuotePayment" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "QuotePayment_tenantId_idempotencyKey_key" ON "QuotePayment"\("tenantId", "idempotencyKey"\);/);
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|ALTER COLUMN|TRUNCATE|DELETE FROM|UPDATE /i);
});

test("the schema model matches the migrations and needs no tenant-guard exemption", () => {
  const schema = read("prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model QuotePayment {"), schema.indexOf("model ServiceReminderLog {"));
  assert.match(model, /^\s*tenantId\s+String\s*$/m, "required tenantId — never an untenanted payment");
  assert.match(model, /voidedAt\s+DateTime\?/);
  assert.doesNotMatch(model, /deletedAt/, "payments are voided, not soft-deleted");
  assert.match(model, /@@unique\(\[tenantId, idempotencyKey\]\)/);
  assert.match(model, /@@index\(\[tenantId, quoteId, receivedAt\]\)/);
  assert.doesNotMatch(read("src/lib/tenantGuard.ts"), /"QuotePayment"/);
});

test("ONE balance: every change to deposit or payments locks the quote and re-reads both", () => {
  const ledger = read("src/lib/quoteLedger.ts");
  const lock = ledger.slice(ledger.indexOf("export async function lockQuoteLedger"), ledger.indexOf("export type QuoteLedger"));
  assert.match(lock, /SELECT id FROM "Quote" WHERE id = \$\{quoteId\} AND "tenantId" = \$\{tenantId\} FOR UPDATE/);
  assert.ok(lock.indexOf("FOR UPDATE") < lock.indexOf("tx.quotePayment.findMany"), "lock, then read");
  assert.match(lock, /tx\.quotePayment\.findMany\(\{ where: \{ quoteId, tenantId \}/);
  assert.match(lock, /owingCents: totalCents - depositCents - paymentsCents/);

  const record = ledger.slice(ledger.indexOf("export async function recordPaymentInTx"), ledger.indexOf("export async function voidPaymentInTx"));
  assert.ok(record.indexOf("lockQuoteLedger(") < record.indexOf("idempotencyKey: input.idempotencyKey }"), "the key is looked up under the lock");
  assert.ok(record.indexOf('kind: "duplicate"') < record.indexOf("ledger.owingCents <= 0"), "a resubmission is answered before any balance refusal");
  assert.match(record, /if \(input\.amountCents > ledger\.owingCents\) refuse\(/, "never more than is owing");

  // The deposit is checked against the payments, for recording AND correcting it.
  assert.match(ledger, /export function assertDepositFits\(ledger: QuoteLedger, depositCents: number, fmt: Money\): void \{\s*if \(depositCents \+ ledger\.paymentsCents <= ledger\.totalCents\) return;/);
  const fulfilment = read("src/app/actions/fulfilment.ts");
  for (const [name, next] of [["markDepositPaid", "correctDepositAmount"], ["correctDepositAmount", "replaceInvoice"]]) {
    const body = fulfilment.slice(fulfilment.indexOf(`export async function ${name}`), fulfilment.indexOf(`export async function ${next}`));
    assert.match(body, /await prisma\.\$transaction\(async \(tx\) => \{\s*const ledger = await lockQuoteLedger\(tx, quoteId, tenantId\);/, `${name} locks`);
    assert.match(body, /assertDepositFits\(ledger, amountCents, formatZAR\);/, `${name} checks the combined balance`);
  }
});

test("recording money: the deposit's grant, strict amounts, payment and audit in one transaction", () => {
  const actions = read("src/app/actions/quotePayments.ts");
  const record = actions.slice(actions.indexOf("export async function recordQuotePayment"), actions.indexOf("export async function voidQuotePayment"));
  assert.match(record, /const user = await requireQuoteAccess\(quoteId, "deliveries\.manage"\);/);
  assert.ok(record.indexOf("requireQuoteAccess") < record.indexOf("refuse("), "auth before any refusal");
  assert.match(record, /const amount = parseMoneyInput\(/, "1 000,50 is R1 000,50");
  assert.doesNotMatch(actions, /parseRands/);
  assert.match(record, /const idempotencyKey = String\(formData\.get\("idempotencyKey"\)/);
  assert.match(record, /recordPaymentInTx\(\s*tx,/);
  assert.match(record, /await logAuditStrict\(/);
  assert.match(record, /action: "payment\.recorded"/);
  assert.match(record, /\}, GOVERNANCE_TX\);/);
  // Two of the same form at the same instant: the unique index answers, recorded once.
  assert.match(record, /error\.code === "P2002"\) duplicate = true;/);
  assert.doesNotMatch(actions, /requireModuleEnabled/, "any workspace that invoices gets paid");

  const form = read("src/components/deals/DealPayments.tsx");
  assert.match(form, /const formKey = crypto\.randomUUID\(\);/);
  assert.match(form, /<input type="hidden" name="idempotencyKey" value=\{formKey\} \/>/);
});

test("a wrong payment is voided with a reason and an audit — never deleted", () => {
  const actions = read("src/app/actions/quotePayments.ts");
  const voiding = actions.slice(actions.indexOf("export async function voidQuotePayment"));
  assert.match(voiding, /const user = await requireQuoteAccess\(quoteId, "deliveries\.manage"\);/);
  assert.match(voiding, /voidPaymentInTx\(tx,/);
  assert.match(voiding, /action: "payment\.voided"/);
  const ledger = read("src/lib/quoteLedger.ts");
  assert.match(ledger, /tx\.quotePayment\.updateMany\(\{\s*where: \{ id: input\.paymentId, quoteId: input\.quoteId, tenantId: input\.tenantId, voidedAt: null \}/);
  assert.doesNotMatch(actions + ledger, /quotePayment\.(delete|deleteMany)\(/);
});

test("every statement query names the workspace; partial statements and trashed figures are withheld", () => {
  const loader = read("src/lib/accountStatementLoader.ts");
  for (const call of loader.match(/prisma\.(contact|quote|fleet|quotePayment)\.find\w+\(\{[^]*?\}\)/g) ?? []) {
    assert.match(call, /tenantId/, `unscoped statement query: ${call.slice(0, 80)}`);
  }
  assert.match(loader, /const access = await statementAccess\(user, own\);\s*if \(!access\) return \{ kind: "partial" \};/);
  assert.match(loader, /const access = await statementAccess\(user, quotes\);\s*if \(!access\) return \{ kind: "partial" \};/);
  // Trashed quotes' numbers and amounts only for workspace-wide quote access.
  assert.match(loader, /if \(await hasPermission\(user, "quotes\.view_all"\)\) return \{ trashDetails: true \};/);
  assert.match(loader, /if \(access\.trashDetails\) return buildAccountStatement\(\[\.\.\.live, \.\.\.trashed\], payments, fmt\);/);
  assert.match(loader, /const statement = buildAccountStatement\(live, payments\.filter\(\(payment\) => liveIds\.has\(payment\.quoteId\)\), fmt\);/);
  // Trash is read deliberately (the scoped client hides it) — only ever to warn.
  assert.match(loader, /prisma\.quote\.findMany\(\{ where: \{ contactId, tenantId, deletedAt: \{ not: null \} \}/);
  assert.match(loader, /prisma\.quote\.findMany\(\{ where: \{ fleetId, tenantId, deletedAt: \{ not: null \} \}/);
  // A fleet-billed invoice is the business's debt, not the signer's.
  assert.match(loader, /const billedHere = \(quote: \{ fleetId: string \| null \}\) => !quote\.fleetId \|\| !fleets\.has\(quote\.fleetId\);/);
  assert.match(loader, /const own = quotes\.filter\(billedHere\);\s*const ownTrash = trash\.filter\(billedHere\);/);
});

test("statement routes apply the same gates as the screens they print from", () => {
  const contact = read("src/app/(print)/contacts/[id]/statement/page.tsx");
  assert.match(contact, /const user = await requireContactReadAccess\(id\);\s*await requireAnyPermission\("quotes\.view_all", "quotes\.view_owned"\);/);
  assert.ok(contact.indexOf("requireContactReadAccess") < contact.indexOf("loadContactStatement("), "no data before the gate");

  const fleet = read("src/app/(print)/fleets/[id]/statement/page.tsx");
  assert.match(fleet, /const user = await requireRoute\("\/fleets"\);\s*await requireAnyPermission\("quotes\.view_all", "quotes\.view_owned"\);/);
  assert.ok(fleet.indexOf("requireRoute") < fleet.indexOf("loadFleetStatement("), "no data before the gate");

  // Links to a statement only render for viewers the route will let in.
  assert.match(read("src/app/(app)/contacts/[id]/page.tsx"), /\{canViewStatement && <Link href=\{`\/contacts\/\$\{contact\.id\}\/statement`\}/);
  assert.match(read("src/app/(app)/fleets/[id]/page.tsx"), /\{canViewStatement && \(\s*<Link href=\{`\/fleets\/\$\{fleet\.id\}\/statement`\}/);
});

test("staff warnings are on screen only — never printed on the customer's copy", () => {
  const doc = read("src/components/print/StatementDocument.tsx");
  assert.match(doc, /<div className="print:hidden[^"]*">\s*\{statement\.warnings\.length > 0/);
  assert.match(doc, /sections: \{ \.\.\.template\.sections, signatures: false \}/, "a statement is not signed");
});
