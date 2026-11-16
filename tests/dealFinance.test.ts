import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  FINANCE_CHASE_WORKING_DAYS,
  FINANCE_STATUSES,
  deliveryRefusal,
  financeBlocksDelivery,
  financeChase,
  financeIsClosed,
  workingDaysBetween,
} from "../src/lib/dealFinanceRules";
import { buildBrief, type BriefInput } from "../src/lib/daxBriefRules";
import { effectiveModuleIds, installWideModuleIds } from "../src/lib/modules/entitlement";
import { MODULE_REGISTRY, OPTIONAL_MODULE_IDS, moduleForPath } from "../src/lib/modules/registry";

test("Finance is its own module, built on Suppliers (Sean 2026-11-16: 'its own module that can be turned off')", () => {
  assert.ok(OPTIONAL_MODULE_IDS.includes("finance"));
  assert.equal(MODULE_REGISTRY.find((mod) => mod.id === "finance")?.requires, "suppliers");
  assert.equal(moduleForPath("/finance"), "finance", "the Finance list (and its nav link) belongs to it");
  assert.equal(moduleForPath("/settings/vendors"), "suppliers");
  // Granted and on; switched off; Suppliers off takes Finance with it — granted or install-wide.
  assert.ok(effectiveModuleIds("suppliers,finance", []).has("finance"));
  assert.ok(!effectiveModuleIds("suppliers,finance", ["finance"]).has("finance"));
  assert.ok(effectiveModuleIds("suppliers,finance", ["finance"]).has("suppliers"), "Finance off leaves Suppliers alone");
  assert.ok(!effectiveModuleIds("suppliers,finance", ["suppliers"]).has("finance"));
  assert.ok(!effectiveModuleIds("finance", []).has("finance"), "granted without Suppliers: off");
  assert.ok(!installWideModuleIds(["suppliers"]).has("finance"));
  assert.ok(installWideModuleIds([]).has("finance"));
  // Existing workspaces with Suppliers are granted it once.
  const sql = read("prisma/migrations/20261116130000_grant_finance_module/migration.sql");
  assert.match(sql, /WHERE 'suppliers' = ANY[\s\S]*AND NOT \('finance' = ANY/);
});

test("module off: every way into finance checks it — pages, the save, the hold, the chaser, the brief", () => {
  assert.match(read("src/app/(app)/finance/page.tsx"), /await requireModuleEnabled\("finance"\);/);
  assert.match(read("src/app/(app)/leads/[id]/page.tsx"), /lead\.tenantId && \(await isModuleEnabled\("finance"\)\)/);
  assert.match(read("src/app/(app)/deals/[id]/page.tsx"), /lead && \(await isModuleEnabled\("finance"\)\)/);
  assert.match(read("src/app/actions/dealFinance.ts"), /if \(!\(await isModuleEnabled\("finance"\)\)\) refuse\(/);
  const lib = read("src/lib/dealFinance.ts");
  for (const name of ["financeAttentionSignals", "financeToChase", "financeDeliveryRefusal", "financeDeliveryRefusalInTx"]) {
    const body = lib.slice(lib.indexOf(`export async function ${name}(`));
    assert.match(body.slice(0, body.indexOf("\n}\n")), /isModuleEnabled\("finance"\)/, name);
  }
  for (const file of ["src/lib/dealFinance.ts", "src/app/actions/dealFinance.ts", "src/app/(app)/finance/page.tsx"]) {
    assert.doesNotMatch(read(file), /Enabled\("suppliers"\)/, `${file}: the Finance switch, not Suppliers'`);
  }
});

/*
 * Finance through an outside finance house (Sean, 2026-11-16): a dated status per deal, chased when it stalls on the
 * customer's documents or the finance house's answer, and no delivery booked until it is approved.
 */

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
// Monday 16 November 2026, 09:00 in Johannesburg.
const MON = new Date("2026-11-16T07:00:00Z");
const day = (iso: string) => new Date(`${iso}T07:00:00Z`);
const deal = (status: string, statusAt = MON) => ({ status, statusAt, financeHouse: "WesBank", reference: "APP-77" });

test("the chaser: 3 working days unmoved, weekends skipped — only while it waits on somebody else", () => {
  assert.equal(FINANCE_CHASE_WORKING_DAYS, 3);
  assert.equal(financeChase(deal("submitted"), day("2026-11-18")), null, "Wednesday: two working days, not yet");
  const thursday = financeChase(deal("submitted"), day("2026-11-19"));
  assert.equal(thursday?.detail, "Finance with WesBank (APP-77) submitted 3 working days ago — no answer recorded");
  assert.equal(thursday?.actionLabel, "Chase the finance house");
  assert.deepEqual(thursday?.since, MON);
  // Submitted on a Friday: Saturday and Sunday don't count — Wednesday is the third working day.
  const friday = day("2026-11-20");
  assert.equal(financeChase(deal("submitted", friday), day("2026-11-24")), null);
  assert.ok(financeChase(deal("submitted", friday), day("2026-11-25")));
  // The customer's documents: chased the same way, naming who to chase.
  assert.equal(financeChase(deal("docs_outstanding"), day("2026-11-19"))?.actionLabel, "Chase the customer");
  // Nothing to chase once the finance house has answered, or it's off.
  for (const status of ["approved", "declined", "paid_out", "withdrawn"]) assert.equal(financeChase(deal(status), day("2026-12-30")), null, status);
  assert.equal(workingDaysBetween(MON, day("2026-11-23")), 5, "a week later is five working days");
});

test("delivery waits for approval: docs outstanding, submitted or declined hold it; approved, paid out or withdrawn don't", () => {
  assert.deepEqual(FINANCE_STATUSES.map((s) => s.value), ["docs_outstanding", "submitted", "approved", "declined", "paid_out", "withdrawn"]);
  assert.deepEqual(FINANCE_STATUSES.filter((s) => financeBlocksDelivery(s.value)).map((s) => s.value), ["docs_outstanding", "submitted", "declined"]);
  assert.equal(financeBlocksDelivery(null), false, "not financed: nothing to wait for");
  assert.match(deliveryRefusal("WesBank", "submitted"), /^Finance with WesBank isn't approved yet \(submitted\)\. Delivery can be booked once it is\.$/);
  assert.match(deliveryRefusal("WesBank", "declined"), /declined the finance.*mark the finance withdrawn/);
});

test("the guard sits in the one booking path (DAX's delivery card calls it too), before anything is written", () => {
  const fulfilment = read("src/app/actions/fulfilment.ts");
  const schedule = fulfilment.slice(fulfilment.indexOf("export async function scheduleDelivery"));
  const guard = schedule.indexOf("const financeHold = await financeDeliveryRefusal(tenantId, quote.leadId);");
  assert.ok(guard > 0, "scheduleDelivery asks");
  assert.ok(guard < schedule.indexOf("attachStageDocument("), "before the paperwork is filed");
  assert.ok(guard < schedule.indexOf("prisma.$transaction"), "before the day is booked");
  assert.match(read("src/app/actions/assistant.ts"), /await scheduleDelivery\(card\.quoteId, form\)/);
});

test("THE HANDOVER ITSELF asks again (review of #1137): before any paperwork, and under its transaction with the row held", () => {
  const delivery = read("src/lib/quoteDelivery.ts");
  const gate = delivery.indexOf("const financeHold = await financeDeliveryRefusal(tenantId, quote.leadId);");
  assert.ok(gate > 0 && gate < delivery.indexOf("input.collectEvidence("), "before the caller's paperwork is staged");
  const tx = delivery.slice(delivery.indexOf("basePrisma.$transaction(async (tx) => {"));
  assert.ok(tx.indexOf("financeDeliveryRefusalInTx(tx, tenantId, quote.leadId)") > tx.indexOf("const updated = await tx.quote.updateMany("), "again, once the quote's row is held");
  assert.match(read("src/lib/dealFinance.ts"), /WHERE f\."tenantId" = \$\{tenantId\} AND f\."leadId" = \$\{leadId\}\s*FOR SHARE OF f/);
  // Both doors use that one handover.
  assert.match(read("src/app/actions/fulfilment.ts"), /return deliverQuote\(\{/);
  assert.match(read("src/app/actions/stock.ts"), /return deliverQuote\(\{/);
  // Real database: scripts/test-delivery-note-signing.ts section 8 (declined / reopened after booking, revoked after signing).
  assert.match(read("scripts/test-delivery-note-signing.ts"), /approved, signed for, then declined: not handed over/);
});

test("saving: leads.edit on THIS lead, a finance house of this workspace only, a dated status, and no lost update", () => {
  const action = read("src/app/actions/dealFinance.ts");
  assert.match(action, /requireLeadAccess\(leadId, "leads\.edit"\)/);
  assert.match(action, /const vendorId = text\(formData, "vendorId", 64\);/);
  assert.match(action, /tx\.dealVendor\.findFirst\(\{\s*where: \{ tenantId, leadId, vendorId, vendor: \{ deletedAt: null, kind: "finance" \} \}/, "only a finance house ON THIS DEAL, whatever is posted");
  assert.match(action, /isFinanceStatus\(status\)/);
  assert.match(action, /where: \{ id: existing\.id, tenantId, updatedAt: existing\.updatedAt \}/, "compare-and-swap on the version (dealFinanceSave.test.ts drives it)");
  assert.match(action, /\(existing\?\.updatedAt\.toISOString\(\) \?\? ""\) !== shown/, "against the version the form SHOWED");
  assert.match(read("src/components/deals/DealFinancePanel.tsx"), /<input type="hidden" name="version" value=\{finance\?\.updatedAt\.toISOString\(\) \?\? ""\} \/>/);
  assert.match(action, /\.\.\.\(moved \? \{ statusAt: new Date\(\) \} : \{\}\)/, "the date moves only with the status");
  assert.doesNotMatch(action, /linkVendorToDeal\(/, "finance never adds the supplier — adding it is what makes the deal financed");
  assert.match(action, /logAudit\(\{ action: "finance\.updated"/);
});

test("a cash deal shows no Finance (Sean 2026-11-16): only a deal with a finance house among its suppliers, or a finance record", () => {
  assert.match(read("src/lib/dealFinance.ts"), /prisma\.dealVendor\.findMany\(\{\s*where: \{ tenantId, leadId, vendor: \{ deletedAt: null, kind: "finance" \} \}/);
  for (const page of ["src/app/(app)/leads/[id]/page.tsx", "src/app/(app)/deals/[id]/page.tsx"]) {
    const src = read(page);
    assert.match(src, /dealFinanceHouses\((lead\.)?tenantId, lead\.id\)/, page);
    assert.match(src, /finance \|\| financeHouses\.length > 0/, page);
    assert.doesNotMatch(src, /kind: "finance"/, `${page}: not every finance house in the workspace`);
  }
});

test("the finance house can't be taken off a deal while its finance is live (review of #1137)", () => {
  for (const s of ["docs_outstanding", "submitted", "approved", "declined"]) assert.equal(financeIsClosed(s), false, s);
  for (const s of ["paid_out", "withdrawn"]) assert.equal(financeIsClosed(s), true, s);
  const vendors = read("src/app/actions/vendors.ts");
  const remove = vendors.slice(vendors.indexOf("export async function removeDealVendor("));
  assert.match(remove, /tx\.dealFinance\.findFirst\(\{ where: \{ tenantId, leadId: quote\.leadId, vendorId \}/);
  assert.ok(remove.indexOf("financeIsClosed(finance.status)") < remove.indexOf("tx.dealVendor.deleteMany("), "checked before the link goes");
  assert.match(remove, /Set the finance to Withdrawn first/);
});

test("the lead board shows a financed deal's finance status (Sean 2026-11-16); a cash deal shows nothing", () => {
  const lib = read("src/lib/dealFinance.ts");
  const board = lib.slice(lib.indexOf("export async function financeOnBoard("));
  assert.match(board, /if \(leadIds\.length === 0 \|\| !\(await isModuleEnabled\("finance"\)\)\) return new Map\(\);/, "Finance module off: no pills");
  assert.match(board, /where: \{ leadId: \{ in: leadIds \} \}/, "only the board's own, already permission-scoped leads");
  const page = read("src/app/(app)/leads/page.tsx");
  assert.match(page, /const financeByLead = await financeOnBoard\(leadIds, now\);/);
  assert.match(page, /finance: financeByLead\.get\(lead\.id\) \?\? null,/);
  assert.match(read("src/components/KanbanBoard.tsx"), /<KanbanFinancePill finance=\{lead\.finance\} \/>/);
  // Collapsed, the card's top row carries it (the open card shows it in full below): Sean, "no finance pills".
  assert.match(read("src/components/KanbanBoard.tsx"), /\{!open && <KanbanFinancePill finance=\{lead\.finance\} compact \/>\}/);
  const pill = read("src/components/deals/KanbanFinancePill.tsx");
  assert.match(pill, /if \(!finance\) return null;/, "nothing on a cash deal");
  assert.doesNotMatch(pill, /dealFinanceRules|@\/lib\/db/, "worked out on the server; the browser gets text");
});

test("starting finance and taking its finance house off the deal take turns: both hold the lead row (follow-up to #1137)", () => {
  const LOCK = /await tx\.\$queryRaw`SELECT 1 FROM "Lead" WHERE "id" = \$\{(quote\.)?leadId\} AND "tenantId" = \$\{tenantId\} FOR UPDATE`;/;
  const save = read("src/app/actions/dealFinance.ts");
  const saveTx = save.slice(save.indexOf("await prisma.$transaction(async (tx) => {"));
  assert.match(saveTx, LOCK);
  assert.ok(saveTx.search(LOCK) < saveTx.indexOf("tx.dealVendor.findFirst("), "the lock comes before the supplier is checked");
  assert.ok(saveTx.indexOf("tx.dealFinance.create(") > 0 && saveTx.indexOf("tx.dealFinance.updateMany(") > 0, "and the write is in the same transaction");
  const vendors = read("src/app/actions/vendors.ts");
  const remove = vendors.slice(vendors.indexOf("export async function removeDealVendor("));
  assert.match(remove, /const link = await prisma\.\$transaction\(async \(tx\) => \{\s*if \(quote\.leadId\) await tx\.\$queryRaw`SELECT 1 FROM "Lead"/);
  assert.ok(remove.search(LOCK) < remove.indexOf("tx.dealFinance.findFirst("), "the lock comes before the finance is checked");
});

test("the table: tenant FKs, one per lead, the statuses checked, row-level security forced", () => {
  const sql = read("prisma/migrations/20261116120000_deal_finance/migration.sql");
  assert.match(sql, /FOREIGN KEY \("tenantId", "leadId"\) REFERENCES "Lead"\("tenantId", "id"\)/);
  assert.match(sql, /FOREIGN KEY \("tenantId", "vendorId"\) REFERENCES "Vendor"\("tenantId", "id"\) ON DELETE RESTRICT/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "DealFinance_tenantId_leadId_key"/);
  for (const s of FINANCE_STATUSES) assert.ok(sql.includes(`'${s.value}'`), s.value);
  assert.match(sql, /ALTER TABLE "DealFinance" FORCE ROW LEVEL SECURITY;/);
  // No applicant papers: the model has no file or document column, and the panel says to keep them with the finance house.
  const fields = read("prisma/finance.prisma").split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(fields, /document|file|blob|storedName/i);
  assert.match(read("src/components/deals/DealFinancePanel.tsx"), /Keep the customer&apos;s ID, payslips and bank statements with the finance house/);
});

test("the chaser reaches people: the Attention Centre (open deals), the morning brief and the Finance page (signed ones too)", () => {
  assert.match(read("src/app/actions/attention.ts"), /"finance_waiting", "followup_unanswered",\n\]\);/, "it can be snoozed or dismissed");
  assert.match(read("src/lib/attention/signals.ts"), /for \(const batch of batches\) \{\s*for \(const \{ leadId, signal \} of await financeAttentionSignals\(batch, now\)\)/, "batched");
  assert.match(read("src/lib/dealFinance.ts"), /prisma\.dealFinance\.findMany\(\{\s*where: \{ leadId: \{ in: leadIds \}/, "through the guarded client, only the leads handed in");
  // A quote signed subject to finance WINS its lead, and the attention list reads open deals only: the brief reads
  // loadFinanceDeals, which keeps won deals.
  assert.match(read("src/lib/dealFinance.ts"), /status: \{ in: \["open", "won"\] \}/);
  const finance = (ownerId: string | null) => ({ leadId: `l-${ownerId}`, name: `Deal ${ownerId}`, ownerId, detail: "Finance with WesBank submitted 4 working days ago — no answer recorded", since: MON, valueCents: 0 });
  const input: BriefInput = { now: day("2026-11-20"), userId: "me", userName: "Sean", leads: [], hot: [], activities: [], testDrives: [], viewedQuotes: [], deliveries: [], finance: [finance("me"), finance(null), finance("someone-else")] };
  const item = buildBrief(input).items.find((i) => i.key === "finance");
  assert.equal(item?.count, 2, "mine and the unassigned — not another rep's");
  assert.equal(item?.href, "/finance");
});
