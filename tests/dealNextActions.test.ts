import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dealBlockers, dealMilestones } from "../src/lib/dealMilestones";

/**
 * Brief §4 (Phase 3) and the deal page redesign (wave 2, W2-05): the deal page says
 * where the deal stands ONCE — from the shared rules — and each step's button goes
 * where that step is done, behind the permission that screen asks.
 */
const page = readFileSync("src/app/(app)/deals/[id]/page.tsx", "utf8");
const panel = readFileSync("src/components/deals/DealStandsPanel.tsx", "utf8");

test("where the deal stands comes from the shared rules, once — not three copies", () => {
  // With the workspace's lifecycle (Phase 4).
  assert.match(page, /const journey = dealMilestones\(facts, lifecycle\)/);
  assert.match(page, /const stand = dealStand\(\{\s*journey,/);
  assert.match(page, /financeHolds: finance \? financeBlocksDelivery\(finance\.status\) : false/);
  assert.match(page, /<DealStandsPanel steps=\{stand\.steps\} holds=\{stand\.holds\} progress=\{progress\} buttons=\{stepButtons\} closed=\{closed\} \/>/);
  // The headline is the same account, not the raw quote status ("sent" while the strip said "Accepted").
  assert.match(page, /status=\{<StatusPill tone=\{stand\.headline\.tone\}>\{stand\.headline\.text\}<\/StatusPill>\}/);
  // The journey strip, "What is in the way" and "Ready to deliver?" are gone.
  assert.doesNotMatch(page, /JourneyStep|DealNextActions|>Readiness<|Customer acceptance outstanding|No deposit terms set|No deposit receipt recorded/);
  // No deposit asked = "not needed", never a failed step, and no blocker.
  const noDeposit = dealMilestones({ accepted: true, depositCents: 0, depositPaid: false, stock: [], deliveryBooked: false, delivered: false });
  assert.equal(noDeposit.find((s) => s.key === "deposit")?.skipped, true);
  assert.ok(!dealBlockers({ accepted: true, depositCents: 0, depositPaid: false, stock: [], deliveryBooked: false, delivered: false }).some((b) => b.key === "deposit"));
});

test("each step's button goes where the step is done, only for someone allowed to do it there", () => {
  assert.match(page, /\.\.\.\(canManageDeliveries \? \{ deposit: \{ label: "Record deposit", href: "\/deliveries" \}, delivery: \{ label: "Book delivery", href: "\/deliveries" \} \} : \{\}\)/);
  assert.match(page, /\.\.\.\(canSeeStock \? \{ stock: \{ label: "Allocate", href: "\/stock" \} \} : \{\}\)/);
  assert.match(page, /\.\.\.\(canSeeStock && unit \? \{ pdi: \{ label: "Open unit", href: `\/stock\/\$\{unit\.id\}` \} \} : \{\}\)/);
  assert.match(page, /hasAnyPermission\(user, "deliveries\.manage"\)/);
  assert.match(page, /hasAnyPermission\(user, "stock\.view", "stock\.manage"\)/);
  // Finance links to the panel on this page, which is only there when the lead may be opened.
  assert.match(page, /\.\.\.\(finance \? \{ finance: \{ label: "Finance", href: "#finance" \} \} : \{\}\)/);
  assert.match(page, /<div id="finance" className="scroll-mt-20">/);
  // Chasing the customer opens the record drawer's composer — only for someone who may open the lead (the drawer re-checks).
  assert.match(page, /lead \? <OpenRecordLink record=\{\{ type: "lead", id: lead\.id \}\}/);
  assert.match(page, /<RecordDrawer \/>/);
  // Buttons only on the step that is NOW or NEXT; the panel itself changes and sends nothing.
  assert.match(panel, /\(step\.state === "now" \|\| step\.state === "next"\) && step\.action \? buttons\[step\.action\] : null/);
  assert.doesNotMatch(panel, /"use server"|"use client"|action=\{|fetch\(/);
});

test("the main button is what the deal needs next; accepting by hand asks first", () => {
  assert.match(page, /quote\.status === "draft"\s*\? <Link href=\{`\/quotes\?edit=\$\{quote\.id\}`\} className="btn-primary">Finish and send the quote<\/Link>/);
  assert.match(page, /nowStep\?\.action === "accept" && lead\s*\? chase\("btn-primary", "Chase the customer"\)/);
  // Mark accepted: the quote's own status action (it wins the lead), behind its permission, and a second click.
  assert.match(page, /canChangeStatus && quote\.status === "sent" && !quote\.signedAt && <MarkAcceptedButton/);
  assert.match(page, /hasPermission\(user, "quotes\.change_status"\)/);
  const accept = readFileSync("src/components/deals/MarkAcceptedButton.tsx", "utf8");
  assert.match(accept, /await setQuoteStatus\(quoteId, "accepted"\)/);
  assert.match(accept, /if \(!confirming\)/);
  assert.match(accept, /Yes, accept/);
});

test("the next step card warns when its date doesn't make sense and fixes it through the activity actions", () => {
  assert.match(page, /const warning = nextStepWarning\(\{/);
  assert.match(page, /validUntil: quote\.validUntil/);
  const card = readFileSync("src/components/deals/DealNextStepCard.tsx", "utf8");
  assert.match(card, /await rescheduleActivity\(next\.id, `\$\{tomorrow\}T09:00`\)/);
  assert.match(card, /await completeActivity\(next\.id, new FormData\(\)\)/);
  // Shown done only once the server said so.
  assert.match(card, /if \(!result\.ok\) return setError/);
  assert.match(page, /canManage=\{canViewActivities && canManageActivities\}/);
});

test("the next step is the deal's: its own planned-only, tenant-named read; what it says needs Activities access", () => {
  // Not a capped include of every activity, where 20 done ones would hide a planned one.
  assert.doesNotMatch(page, /activities: \{ orderBy: \{ dueDate: "asc" \}, take: 20 \}/);
  assert.match(page, /prisma\.activity\.findFirst\(\{\s*where: \{ tenantId, leadId: lead\.id, status: "planned", availabilityBlock: false \},\s*orderBy: \[\{ dueDate: "asc" \}, \{ id: "asc" \}\]/);
  // Whoever it is assigned to, named — not passed off as the viewer's.
  assert.match(page, /who: canViewActivities \? \(nextActivity\.assignedToId === user\.id \? "You" : nextActivity\.assignedTo\.name\) : null/);
  // Without Activities access: only when, as the page always showed; no summary, type, buttons or schedule link.
  assert.match(page, /summary: canViewActivities \? nextActivity\.summary : null/);
  assert.match(page, /type: canViewActivities \? nextActivity\.type : null/);
  assert.match(page, /hasAnyPermission\(user, "activities\.view", "activities\.manage"\)/);
  assert.match(page, /scheduleHref=\{canManageActivities \? `\/leads\/\$\{lead\.id\}\?tab=activities&schedule=1` : null\}/);
  const card = readFileSync("src/components/deals/DealNextStepCard.tsx", "utf8");
  assert.match(card, /\{next\.summary \?\? `Planned for \$\{next\.when\}`\}/);
  assert.doesNotMatch(card, /Your next step/);
});

test("a declined or cancelled deal has no main button, nothing to chase and no next-step card", () => {
  assert.match(page, /const primaryAction = closed\s*\? null/);
  assert.match(page, /const nextStepCard = lead && !closed \?/);
  assert.match(page, /closed=\{closed\}/);
  assert.match(panel, /this deal is closed/);
});

test("a finance hold is on the panel with its button, and is the main button while it holds", () => {
  assert.match(page, /holds=\{stand\.holds\}/);
  assert.match(page, /: hold && stepLinks\[hold\.action\]/);
  assert.match(panel, /\{buttons\[hold\.action\]\}/);
  assert.match(panel, /On hold: \{hold\.label\}/);
});

test("money on the page: total, paid and owed in the deal's own currency, from real payments only", () => {
  assert.match(page, /const paid = invoice \? receivedCents\(quote, payments\) : 0;/);
  assert.match(page, /\{invoice \? "Owed" : "Owed once accepted"\}/);
  assert.match(page, /const moneyFmt = withCurrency\(regional, quote\.currency\);/);
});
