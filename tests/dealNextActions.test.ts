import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dealBlockers, dealMilestones } from "../src/lib/dealMilestones";

/**
 * Brief §4 (Phase 3): the deal page surfaces what is in the way and where each
 * thing is fixed — from the shared rules, behind the permission each screen asks.
 */
const page = readFileSync("src/app/(app)/deals/[id]/page.tsx", "utf8");
const panel = readFileSync("src/components/deals/DealNextActions.tsx", "utf8");

test("the journey, the step it is on and its blockers come from the shared rules, not a second copy", () => {
  // With the workspace's lifecycle (Phase 4).
  assert.match(page, /const journey = dealMilestones\(facts, lifecycle\)/);
  assert.match(page, /const blockers = dealBlockers\(facts, lifecycle\)/);
  assert.match(page, /financeHolds: finance \? financeBlocksDelivery\(finance\.status\) : false/);
  // The old inline journey is gone.
  assert.doesNotMatch(page, /\{ label: "Deposit", done: Boolean\(quote\.depositPaidAt\) \}/);
  // A step that does not apply says so.
  assert.match(page, /skipped=\{step\.skipped\}/);
  // The readiness card reads the SAME deposit step: no deposit asked = "not needed", not a failed row
  // (review of #1230), and no "No deposit receipt recorded" for a deal that never asked for one.
  // #1231: the row's words are the lifecycle's own, and a lifecycle without a deposit step has no row.
  assert.match(page, /const depositStep = journey\.find\(\(step\) => step\.key === "deposit"\);/);
  assert.match(page, /skipped=\{depositStep\.skipped\} label=\{ready\.deposit\}/);
  assert.doesNotMatch(page, /No deposit receipt recorded/);
  const noDeposit = dealMilestones({ accepted: true, depositCents: 0, depositPaid: false, stock: [], deliveryBooked: false, delivered: false });
  assert.equal(noDeposit.find((s) => s.key === "deposit")?.skipped, true);
  assert.ok(!dealBlockers({ accepted: true, depositCents: 0, depositPaid: false, stock: [], deliveryBooked: false, delivered: false }).some((b) => b.key === "deposit"));
});

test("each button goes where the step is done, only for someone allowed to do it there", () => {
  assert.match(page, /deposit: canManageDeliveries \? \{ label: "Record deposit", href: "\/deliveries" \} : null/);
  assert.match(page, /delivery: canManageDeliveries \? \{ label: "Book delivery", href: "\/deliveries" \} : null/);
  assert.match(page, /stock: canSeeStock \? \{ label: "Allocate", href: "\/stock" \} : null/);
  assert.match(page, /hasAnyPermission\(user, "deliveries\.manage"\)/);
  assert.match(page, /hasAnyPermission\(user, "stock\.view", "stock\.manage"\)/);
  // Finance links to the panel on this page, which is only there when the lead may be opened.
  assert.match(page, /finance: finance \? \{ label: "Finance", href: "#finance" \} : null/);
  assert.match(page, /<div id="finance" className="scroll-mt-20">/);
  // The panel only links; nothing is changed or sent from it.
  assert.doesNotMatch(panel, /"use server"|action=\{|fetch\(/);
});
