import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { OPENED_LEGEND, openedFact } from "../src/lib/emailOpenTracking";

// Asked "has he opened his email?", the assistant answered that the CRM doesn't
// show it. The CRM does (Communication.seenAt) — the assistant's lookup never read it.
//
// What it is now given says only as much as the CRM knows (review of #868):
// what tracking SAW is not whether the email was READ, and a timeline entry is
// not proof an email was SENT.

const sent = { type: "email", direction: "outbound" };
const at = new Date("2026-10-12T10:05:00Z");

test("what tracking saw: opened, no open detected, not tracked — three answers, none of them about reading", () => {
  assert.deepEqual(openedFact({ ...sent, openToken: "t", seenAt: at, openCount: 1 }), { emailOpen: "opened", openedAt: at.toISOString(), provenance: "sent_by_crm" });
  assert.deepEqual(openedFact({ ...sent, openToken: "t", seenAt: at, openCount: 3 }), { emailOpen: "opened", openedAt: at.toISOString(), openedTimes: 3, provenance: "sent_by_crm" });
  assert.deepEqual(openedFact({ ...sent, openToken: "t", seenAt: null, openCount: 0 }), { emailOpen: "no_open_detected", provenance: "sent_by_crm" });
  // Tracking off, or sent before it existed: nothing is known, and that is what is said.
  assert.deepEqual(openedFact({ ...sent, openToken: null, messageId: "<id@mail>", seenAt: null }), { emailOpen: "not_tracked", provenance: "sent_by_crm" });
});

test("NO BOOLEAN: nothing the assistant is given can be read as proof an email was not read", () => {
  for (const row of [
    { ...sent, openToken: "t", seenAt: null },
    { ...sent, openToken: null, seenAt: null },
    { ...sent, openToken: "t", seenAt: at },
  ]) {
    const fact = openedFact(row) as Record<string, unknown>;
    assert.ok(!("opened" in fact), "the old `opened: false` is gone");
    for (const value of Object.values(fact)) assert.notEqual(typeof value, "boolean");
  }
  assert.doesNotMatch(readFileSync("src/lib/emailOpenTracking.ts", "utf8"), /opened: false\b(?!`)/);
});

test("PROVENANCE: an email only RECORDED on the timeline is not described as sent", () => {
  // Logged by hand (or by anything that left neither a tracking token nor the mail server's id).
  assert.deepEqual(openedFact({ ...sent, openToken: null, messageId: null, seenAt: null }), { emailOpen: "not_tracked", provenance: "recorded_only" });
  assert.deepEqual(openedFact({ ...sent }), { emailOpen: "not_tracked", provenance: "recorded_only" });
  // Either mark of the CRM's own send is enough.
  assert.equal((openedFact({ ...sent, openToken: "t" }) as { provenance: string }).provenance, "sent_by_crm");
  assert.equal((openedFact({ ...sent, messageId: "<id@mail>" }) as { provenance: string }).provenance, "sent_by_crm");
});

test("only an email we sent carries any of this", () => {
  assert.deepEqual(openedFact({ type: "email", direction: "inbound", openToken: "t", seenAt: at }), {});
  assert.deepEqual(openedFact({ type: "whatsapp", direction: "outbound", openToken: null, seenAt: at }), {});
  assert.deepEqual(openedFact({ type: "note", direction: null }), {});
});

test("THE WORDING the assistant is told to use, state by state", () => {
  // Opened: detected, not proof of reading.
  assert.match(OPENED_LEGEND, /"opened": tracking detected an open[^.]*\(the mail app loaded it; Apple Mail can do that unread\) — say it was opened, not that it was read\./);
  // No open detected: may still have been read.
  assert.match(OPENED_LEGEND, /"no_open_detected": tracking was on and no open is recorded — the recipient may still have read it/);
  assert.match(OPENED_LEGEND, /say no open has been detected, never that it is unread or unopened for certain/);
  // Not tracked: cannot tell.
  assert.match(OPENED_LEGEND, /"not_tracked": the CRM cannot tell whether it was opened\./);
  // Recorded only: logged, which alone does not establish it was sent.
  assert.match(OPENED_LEGEND, /"recorded_only": an email is logged on the timeline, which alone does not establish that it was sent — say it is recorded, not that it went out\./);
  assert.match(OPENED_LEGEND, /never whether it was READ/);
  // The first version told the assistant every listed email had gone out. It no longer does.
  assert.doesNotMatch(OPENED_LEGEND, /do not suggest checking whether it went out|was accepted for sending — do not/);
});

test("the assistant's lead lookup reads what both facts need, and passes them on with the legend", () => {
  const lookup = readFileSync("src/lib/crmAssistant.ts", "utf8");
  assert.match(lookup, /openToken: true, messageId: true, seenAt: true, openCount: true,/);
  assert.match(lookup, /\.\.\.openedFact\(c\),/);
  assert.match(lookup, /opens: OPENED_LEGEND,/);
});
