import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { auditEntryType, customerHistoryDay, matchesCustomerHistoryFilter } from "../src/lib/customerHistoryFilters";

test("an audit line that only repeats an entry already in the history is under Changes, not All", () => {
  // "Sent email to …" sat right above the email itself: every email appeared twice.
  for (const action of ["email.sent", "whatsapp.sent", "activity.scheduled", "activity.logged", "activity.done"]) {
    assert.equal(auditEntryType(action), "audit-mirror", action);
    assert.equal(matchesCustomerHistoryFilter(auditEntryType(action), "all"), false, action);
    assert.equal(matchesCustomerHistoryFilter(auditEntryType(action), "audit"), true, action);
  }
  // A change the history has no other entry for stays in All.
  for (const action of ["contact.updated", "quote.emailed", "lead.created", "communication.deleted"]) {
    assert.equal(matchesCustomerHistoryFilter(auditEntryType(action), "all"), true, action);
  }
  assert.match(readFileSync("src/components/LeadTimeline.tsx", "utf8"), /type: auditEntryType\(entry\.action\),/);
});

test("the history shows a page at a time, and the context comes first on a narrow screen", () => {
  const history = readFileSync("src/components/CustomerHistory.tsx", "utf8");
  assert.match(history, /const visible = matching\.slice\(0, shown\);/);
  assert.match(history, /Show older \(\{older\} more\)/);
  assert.match(history, /<aside className="order-first min-w-0 space-y-4 xl:order-none"/);
  // What the team pinned comes FIRST in the column, highlighted; an empty card waits below the context (Sean, 2026-10-18).
  const aside = history.slice(history.indexOf("<aside"), history.indexOf("</aside>"));
  assert.ok(aside.indexOf("{pinned.length > 0 && (") < aside.indexOf("{context}"), "pins before the context");
  assert.ok(aside.indexOf("{pinned.length === 0 && (") > aside.indexOf("{context}"), "the empty card after it");
  assert.match(aside, /border-amber-400\/50 bg-amber-400\/\[0\.07\]/);
});

test("a link to another section switches tab in place, so nothing being typed is lost", () => {
  const page = readFileSync("src/app/(app)/contacts/[id]/page.tsx", "utf8");
  assert.doesNotMatch(page, /<Tabs\s+key=/, "a keyed Tabs rebuilds every panel on a ?tab= change");
  assert.doesNotMatch(page, /href=\{`\$\{path\}\?tab=/);
  assert.match(page, /<TabLink tab="activities"/);
  // The WhatsApp box says what became of the message, not a fixed "queued".
  assert.match(readFileSync("src/components/WhatsAppPanel.tsx", "utf8"), /\{composerOnly && state\?\.ok && <p role="status" className="mt-2 text-sm text-emerald-400">\{state\.ok\}<\/p>\}/);
});

test("history day headings use South African midnight, including a UTC date boundary", () => {
  assert.equal(customerHistoryDay(new Date("2026-10-15T21:59:00Z")), "15 October 2026");
  assert.equal(customerHistoryDay(new Date("2026-10-15T22:00:00Z")), "16 October 2026");
  assert.equal(customerHistoryDay(new Date("2026-10-16T02:00:00Z")), "16 October 2026");
});

test("All keeps social and legacy channels that have no dedicated filter", () => {
  for (const channel of ["messenger", "instagram", "meeting", "legacy-channel"]) {
    assert.equal(matchesCustomerHistoryFilter(channel, "all"), true);
    assert.equal(matchesCustomerHistoryFilter(channel, "email"), false);
  }
});

test("channel filters do not mix internal notes, activities or audit changes with messages", () => {
  const types = ["note", "activity", "audit", "email", "whatsapp", "call"];
  for (const filter of ["note", "activity", "audit", "email", "whatsapp", "call"] as const) {
    assert.deepEqual(types.filter((type) => matchesCustomerHistoryFilter(type, filter)), [filter]);
  }
});
