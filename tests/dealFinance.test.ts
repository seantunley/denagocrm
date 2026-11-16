import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  FINANCE_CHASE_WORKING_DAYS,
  FINANCE_STATUSES,
  deliveryRefusal,
  financeBlocksDelivery,
  financeChase,
  workingDaysBetween,
} from "../src/lib/dealFinanceRules";
import { buildBrief, type BriefInput } from "../src/lib/daxBriefRules";

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

test("saving: leads.edit on THIS lead, a finance house of this workspace only, a dated status, and no lost update", () => {
  const action = read("src/app/actions/dealFinance.ts");
  assert.match(action, /requireLeadAccess\(leadId, "leads\.edit"\)/);
  assert.match(action, /tenantId, deletedAt: null, kind: "finance" \}/, "only a finance house, whatever is posted");
  assert.match(action, /isFinanceStatus\(status\)/);
  assert.match(action, /where: \{ id: existing\.id, tenantId, status: existing\.status, statusAt: existing\.statusAt \}/);
  assert.match(action, /\.\.\.\(moved \? \{ statusAt: new Date\(\) \} : \{\}\)/, "the date moves only with the status");
  assert.match(action, /linkVendorToDeal\(/, "the finance house joins the deal's suppliers, so its papers are asked for");
  assert.match(action, /logAudit\(\{ action: "finance\.updated"/);
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
  const signals = read("src/lib/attention/signals.ts");
  assert.match(signals, /prisma\.dealFinance\.findMany\(\{\s*where: \{ leadId: \{ in: batch \}/, "batched, through the guarded client");
  // A quote signed subject to finance WINS its lead, and the attention list reads open deals only: the brief reads
  // loadFinanceDeals, which keeps won deals.
  assert.match(read("src/lib/dealFinance.ts"), /status: \{ in: \["open", "won"\] \}/);
  const finance = (ownerId: string | null) => ({ leadId: `l-${ownerId}`, name: `Deal ${ownerId}`, ownerId, detail: "Finance with WesBank submitted 4 working days ago — no answer recorded", since: MON, valueCents: 0 });
  const input: BriefInput = { now: day("2026-11-20"), userId: "me", userName: "Sean", leads: [], hot: [], activities: [], testDrives: [], viewedQuotes: [], deliveries: [], finance: [finance("me"), finance(null), finance("someone-else")] };
  const item = buildBrief(input).items.find((i) => i.key === "finance");
  assert.equal(item?.count, 2, "mine and the unassigned — not another rep's");
  assert.equal(item?.href, "/finance");
});
