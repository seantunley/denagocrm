import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/*
 * Customer statements (2026-10-28): payments after the deposit are QuotePayment
 * rows, and a statement lists every invoice less every deposit and payment. These
 * pin the parts a refactor could quietly loosen — the table's tenant isolation,
 * who may record money, that a wrong entry is voided not deleted, and that a
 * statement never pools workspaces or prints with an invoice missing.
 */

const read = (path: string) => readFileSync(path, "utf8");
const MIGRATION = "prisma/migrations/20261028120000_quote_payments/migration.sql";

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

test("the schema model matches the migration and needs no tenant-guard exemption", () => {
  const schema = read("prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model QuotePayment {"), schema.indexOf("model ServiceReminderLog {"));
  assert.match(model, /^\s*tenantId\s+String\s*$/m, "required tenantId — never an untenanted payment");
  assert.match(model, /voidedAt\s+DateTime\?/);
  assert.doesNotMatch(model, /deletedAt/, "payments are voided, not soft-deleted");
  assert.match(model, /@@index\(\[tenantId, quoteId, receivedAt\]\)/);
  assert.doesNotMatch(read("src/lib/tenantGuard.ts"), /"QuotePayment"/);
});

test("recording money: the deposit's grant, gated before any refusal, locked against double-recording", () => {
  const actions = read("src/app/actions/quotePayments.ts");
  const record = actions.slice(actions.indexOf("export async function recordQuotePayment"), actions.indexOf("export async function voidQuotePayment"));
  assert.match(record, /const user = await requireQuoteAccess\(quoteId, "deliveries\.manage"\);/);
  assert.ok(record.indexOf("requireQuoteAccess") < record.indexOf("refuse("), "auth before any refusal");
  // The quote row is locked IN ITS WORKSPACE before the outstanding check, so two
  // payments recorded at once cannot both pass it.
  assert.match(record, /FOR UPDATE`/);
  assert.match(record, /SELECT id FROM "Quote" WHERE id = \$\{quoteId\} AND "tenantId" = \$\{tenantId\} FOR UPDATE/);
  assert.ok(record.indexOf("FOR UPDATE") < record.indexOf("outstandingCents("), "lock, then check");
  assert.match(record, /if \(amountCents > owing\) refuse\(/, "never more than is owing");
  assert.match(record, /tx\.quotePayment\.findMany\(\{ where: \{ quoteId, tenantId \} \}\)/);
  assert.match(record, /tenantId: quote\.tenantId \?\? tenantId,/);
  // Payment and audit commit together.
  assert.match(record, /await logAuditStrict\(/);
  assert.match(record, /action: "payment\.recorded"/);
  assert.match(record, /\}, GOVERNANCE_TX\);/);
  assert.doesNotMatch(actions, /requireModuleEnabled/, "any workspace that invoices gets paid");
});

test("a wrong payment is voided with a reason and an audit — never deleted", () => {
  const actions = read("src/app/actions/quotePayments.ts");
  const voiding = actions.slice(actions.indexOf("export async function voidQuotePayment"));
  assert.match(voiding, /const user = await requireQuoteAccess\(quoteId, "deliveries\.manage"\);/);
  assert.match(voiding, /tx\.quotePayment\.updateMany\(\{\s*where: \{ id: paymentId, quoteId, tenantId, voidedAt: null \}/);
  assert.match(voiding, /action: "payment\.voided"/);
  assert.doesNotMatch(actions, /quotePayment\.(delete|deleteMany)\(/);
});

test("every statement query names the workspace, and a partial statement is refused", () => {
  const loader = read("src/lib/accountStatementLoader.ts");
  for (const call of loader.match(/prisma\.(contact|quote|fleet|quotePayment)\.find\w+\(\{[^]*?\}\)/g) ?? []) {
    assert.match(call, /tenantId/, `unscoped statement query: ${call.slice(0, 80)}`);
  }
  assert.match(loader, /if \(!\(await viewerSeesEveryQuote\(user, own\)\)\) return \{ kind: "partial" \};/);
  assert.match(loader, /if \(!\(await viewerSeesEveryQuote\(user, quotes\)\)\) return \{ kind: "partial" \};/);
  // A fleet-billed invoice is the business's debt, not the signer's.
  assert.match(loader, /const own = quotes\.filter\(\(quote\) => !quote\.fleetId \|\| !fleets\.has\(quote\.fleetId\)\);/);
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
