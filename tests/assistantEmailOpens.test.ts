import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { OPENED_LEGEND, openedFact } from "../src/lib/emailOpenTracking";

// Asked "has he opened his email?", the assistant answered that the CRM doesn't
// show it. The CRM does (Communication.seenAt) — the assistant's lookup never read it.

test("opened, not opened yet, and not tracked are three different answers", () => {
  const sent = { type: "email", direction: "outbound" };
  const at = new Date("2026-10-12T10:05:00Z");
  assert.deepEqual(openedFact({ ...sent, openToken: "t", seenAt: at, openCount: 1 }), { opened: at.toISOString() });
  assert.deepEqual(openedFact({ ...sent, openToken: "t", seenAt: at, openCount: 3 }), { opened: at.toISOString(), openedTimes: 3 });
  assert.deepEqual(openedFact({ ...sent, openToken: "t", seenAt: null, openCount: 0 }), { opened: false });
  // Not tracked (tracking off, or sent before it existed): say nothing, never "unopened".
  assert.deepEqual(openedFact({ ...sent, openToken: null, seenAt: null }), {});
});

test("only an email we sent can be opened", () => {
  const at = new Date();
  assert.deepEqual(openedFact({ type: "email", direction: "inbound", openToken: "t", seenAt: at }), {});
  assert.deepEqual(openedFact({ type: "whatsapp", direction: "outbound", openToken: null, seenAt: at }), {});
  assert.deepEqual(openedFact({ type: "note", direction: null }), {});
});

test("the assistant's lead lookup reads the open and passes it on, with what it means", () => {
  const lookup = readFileSync("src/lib/crmAssistant.ts", "utf8");
  assert.match(lookup, /openToken: true, seenAt: true, openCount: true,/);
  assert.match(lookup, /\.\.\.openedFact\(c\),/);
  assert.match(lookup, /opens: OPENED_LEGEND,/);
  assert.match(OPENED_LEGEND, /not proof/);
  assert.match(OPENED_LEGEND, /not tracked/);
});
