import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("what the assistant changes is in the audit trail", () => {
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /if \(learnedCount > 0\) \{\s*await logAudit\(\{\s*action: "assistant\.learned",/, "what it learned (count, not text)");
  const action = code("src/app/actions/assistant.ts");
  const run = action.slice(action.indexOf("export async function runAssistantAction"), action.indexOf("export async function openAssistantBubble"));
  assert.match(run, /action: "assistant\.action_confirmed"/);
  // Every confirmed proposal that changes a lead records it — only after it worked. A calendar item, which may be on
  // a deal, a customer or nobody, records it on whichever it is on (confirmedOn).
  for (const what of ["schedule a ", "add a note", "give the lead to ", "move the lead", "book a meeting", "book a test drive"]) {
    assert.match(run, new RegExp(`if \\(!?result[^)]*\\)[^\\n]*return \\{ ok: false[^\\n]*\\n\\s*await confirmed(?:On)?\\(\`?"?${what}`), what);
  }
  assert.match(run, /const confirmedOn = \(what: string, on: \{ leadId: string \| null; contactId: string \| null \}\) =>\s*logAudit\(\{ action: "assistant\.action_confirmed", summary: `Confirmed the assistant's proposal: \$\{what\}`, user, leadId: on\.leadId, contactId: on\.contactId \}\);/);
  assert.match(code("src/lib/assistantScheduleRun.ts"), /action: "assistant\.schedule_switched_off"/);
  const wa = code("src/lib/assistantWhatsApp.ts");
  assert.match(wa, /the code was issued before this account's sign-ins were reset/);
});

test("limits reached go to the System Log once — who and which, never the question", () => {
  const limits = code("src/lib/assistantUser.ts");
  assert.match(limits, /if \(!result\.allowed && result\.retryAfterSeconds \* 1000 >= policy\.blockMs\) \{\s*await logError\("crm-assistant", `\$\{kind\} limit reached`, `user \$\{userId\}/);
  for (const kind of ["ask", "voice", "image", "web"]) assert.match(limits, new RegExp(`allowedUnder\\(rateLimitKey\\("assistant-${kind}", userId\\), "assistant-${kind}", userId,`), kind);
  const wa = code("src/lib/assistantWhatsApp.ts");
  assert.match(wa, /logError\("assistant-whatsapp", "link code guessing blocked for a number"\)/);
  assert.match(wa, /logError\("assistant-whatsapp", "link code guessing blocked for the workspace"\)/);
});
