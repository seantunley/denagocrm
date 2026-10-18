import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stageContactAt } from "../src/lib/stageContact";
import { INTERNAL_COMMUNICATION_TYPES, LOGGABLE_COMMUNICATION_TYPES, NOTE_KINDS } from "../src/lib/customerContact";

// Sean, 2026-10-18: leads with a pinned note — one sitting in Contacted — said "Never contacted".
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

test("past the pipeline's first stage = contacted, dated to the move; the first stage says nothing", () => {
  const firsts = new Map([["p1", 0], ["p2", 5]]);
  const at = new Date("2026-10-07T09:00:00Z");
  assert.equal(stageContactAt({ stageEnteredAt: at, stage: { order: 1, pipelineId: "p1" } }, firsts), at);
  assert.equal(stageContactAt({ stageEnteredAt: at, stage: { order: 0, pipelineId: "p1" } }, firsts), null);
  assert.equal(stageContactAt({ stageEnteredAt: at, stage: { order: 5, pipelineId: "p2" } }, firsts), null, "p2 starts at 5");
  assert.equal(stageContactAt({ stageEnteredAt: at, stage: { order: 3, pipelineId: "unknown" } }, firsts), null, "no stages known: no claim");
});

test("EVERY reader of a lead's last contact takes the stage move — one rule, so lists can't disagree", () => {
  for (const file of ["src/lib/leadScoreLoader.ts", "src/lib/crmAssistant.ts", "src/lib/crmAssistantStats.ts", "src/lib/assistantWatch.ts"]) {
    const src = read(file);
    assert.match(src, /import \{ firstStageOrders, stageContactAt \} from "\.\/stageContact";/, file);
    assert.match(src, /const firstOrders = await firstStageOrders\(/, file);
    assert.match(src, /stageContactAt\([a-z]+, firstOrders\)/, file);
  }
});

test("'What was this?' on the note box: an internal note by default; a call, WhatsApp or visit is saved AS contact", () => {
  assert.deepEqual(NOTE_KINDS.map((kind) => kind.value), ["note", "call", "whatsapp", "meeting"]);
  assert.equal(NOTE_KINDS[0].value, "note", "the default stays the internal note");
  for (const kind of NOTE_KINDS.slice(1)) assert.ok(!(INTERNAL_COMMUNICATION_TYPES as readonly string[]).includes(kind.value), `${kind.value} counts as contact`);
  const form = read("src/components/CustomerLogForm.tsx");
  assert.match(form, /<select id=\{`\$\{prefix\}-kind`\} name="type" className="input" defaultValue="note">/);
  assert.doesNotMatch(form, /<input type="hidden" name="type" value="note" \/>/, "the type is chosen, not fixed");
});

test("the server accepts only the kinds a person can log — the type decides 'contacted' now", () => {
  assert.deepEqual([...LOGGABLE_COMMUNICATION_TYPES], ["note", "call", "email", "whatsapp", "meeting"]);
  for (const kind of NOTE_KINDS) assert.ok((LOGGABLE_COMMUNICATION_TYPES as readonly string[]).includes(kind.value));
  const action = read("src/app/actions/communications.ts");
  assert.match(action, /const type = str\("type"\) \?\? "note";\s*if \(!\(LOGGABLE_COMMUNICATION_TYPES as readonly string\[\]\)\.includes\(type\)\) refuse\(/);
  assert.match(action, /data: \{\s*type,\s*direction: str\("direction"\),/);
});
