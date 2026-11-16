import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSteps } from "../src/lib/crmAssistantPlan";
import { ACTION_INSTRUCTIONS, proposedAction } from "../src/lib/assistantActions";
import { FINANCE_RULE } from "../src/lib/assistantFinanceRules";
import { WHATSAPP_CONFIRMABLE } from "../src/lib/assistantWhatsAppRules";
import { familyOf } from "../src/lib/assistantOutcomeRules";

/*
 * DAX and finance (Sean, 2026-11-16): reads the Finance page's own list, and moves a deal's finance only through a
 * card the person confirms — the deal's own Save, with what the card showed checked again first.
 */

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

test("the finance lookup: planned like any other, by customer, status or what to chase", () => {
  const [step] = parseSteps('{"tool":"finance","args":{"customer":"Jody","toChase":true}}') ?? [];
  assert.deepEqual(step, { tool: "finance", args: { customer: "Jody", toChase: true } });
  assert.equal(parseSteps('{"tool":"finance","args":{"status":"maybe"}}'), null, "only a real status");
  const lookup = read("src/lib/assistantFinance.ts");
  assert.match(lookup, /loadFinanceDeals\(user, now, \{ active: !args\.all \}\)/, "the Finance page's own list: only deals this person may open");
  assert.match(lookup, /isModuleEnabled\("suppliers"\)/);
});

test("the card: proposed with a real status, shown before Confirm, and refused at Confirm if it moved since", () => {
  assert.ok(ACTION_INSTRUCTIONS.includes(FINANCE_RULE));
  assert.match(FINANCE_RULE, /never move it further than that/);
  const LEAD = "cmwgitom40004l307g474vwt7";
  assert.equal(proposedAction.safeParse({ type: "finance", leadId: LEAD, status: "approved", financeHouse: "WesBank" }).success, true);
  assert.equal(proposedAction.safeParse({ type: "finance", leadId: LEAD, status: "pending" }).success, false, "only a real status");
  const card = read("src/lib/assistantFinance.ts");
  assert.match(card, /hasPermission\(user, "leads\.edit"\)/);
  assert.match(card, /kind: "finance"\s*\}/, "only a finance house of this workspace");
  assert.match(card, /never a guess/, "an unnamed house is the deal's own, else the only one — otherwise it asks");
  assert.match(card, /wasStatus: current\?\.status \?\? null, wasStatusAt: current\?\.statusAt\.toISOString\(\) \?\? null/);
  assert.match(card, /\(now\?\.status \?\? null\) !== card\.wasStatus \|\| \(now\?\.statusAt\.toISOString\(\) \?\? null\) !== card\.wasStatusAt/);
  assert.match(card, /Nobody is contacted\./);
  const confirm = read("src/app/actions/assistant.ts");
  assert.match(confirm, /case "finance": \{[\s\S]*?await saveDealFinance\(card\.leadId, step\.form\)/, "the deal's own Save");
  assert.ok(WHATSAPP_CONFIRMABLE.has("finance"), "confirmable on WhatsApp too");
  assert.equal(familyOf("finance").key, "stage");
});
