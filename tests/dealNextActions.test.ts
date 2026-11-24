import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
