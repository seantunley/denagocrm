import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (path: string) => readFileSync(path, "utf8");
const page = read("src/app/(app)/leads/[id]/page.tsx");

test("the deal opens its shared workspace and preserves edit/activity deep links", () => {
  assert.match(page, /initialKey=\{tab \?\? \(edit === "1" \? "details" : "comms"\)\}/);
  assert.match(page, /startOpen=\{tab === "activities" && schedule === "1"\}/);
  // Every section is its own tab — Customer and Research are not hidden behind "More" (Sean, 2026-10-18).
  assert.doesNotMatch(page, /overflowKeys=/);
  for (const key of ["comms", "details", "activities", "quotes", "customer", "research"]) assert.ok(page.includes(`key: "${key}"`), key);
  // …and on the customer page too: the "More" dropdown is gone from the shared Tabs altogether, so no page can bring it back.
  assert.doesNotMatch(read("src/app/(app)/contacts/[id]/page.tsx"), /overflowKeys=/);
  const tabs = read("src/components/Tabs.tsx");
  assert.doesNotMatch(tabs, /overflowKeys|<select|>More</);
  assert.equal((page.match(/<LeadTimeline/g) ?? []).length, 1);
  assert.doesNotMatch(page, /<CommsTimeline/);
  assert.match(page, /<WhatsAppPanel composerOnly[^>]*leadId=\{lead\.id\}/);
});
test("both note and call forms file on the current deal, never a different deal", () => {
  for (const mode of ["note", "call"]) assert.ok(page.includes(`<CustomerLogForm mode="${mode}" leadId={lead.id}`));
  const form = read("src/components/CustomerLogForm.tsx");
  assert.match(form, /leadId && <input type="hidden" name="leadId" value=\{leadId\}/);
  assert.match(form, /!leadId && deals\.length > 0 && <DealField/);
});
test("quote counts, summary, list and email chooser use only viewable quotes", () => {
  assert.match(page, /const visibleQuotes = lead\.quotes\.filter\(\(quote\) => canPrintQuote\(quote\.id\)\);/);
  assert.match(page, /const latestQuote = visibleQuotes\.find/);
  assert.match(page, /count: visibleQuotes\.length/);
  assert.match(page, /visibleQuotes\.map\(\(q\)/);
  assert.match(page, /quotes=\{composerQuotes\(visibleQuotes,/);
  assert.doesNotMatch(page, /count: lead\.quotes\.length|\{lead\.quotes\.map/);
});
test("promoted actions retain permission checks and destructive confirmations", () => {
  for (const permission of ["quotes.create", "leads.mark_won", "leads.mark_lost", "leads.reopen", "leads.delete", "leads.link_contact"]) assert.ok(page.includes(`hasPermission(user, "${permission}")`));
  assert.match(page, /canDeleteLead && <ConfirmDelete/);
  assert.match(page, /canMarkWon && <MarkWonButton/);
  assert.match(page, /\["open", "nurture"\]\.includes\(lead\.status\) && canMarkLost/);
  assert.match(page, /\["won", "lost"\]\.includes\(lead\.status\) && canReopen/);
  assert.match(page, /name="lostReason"[\s\S]*?required/);
});
