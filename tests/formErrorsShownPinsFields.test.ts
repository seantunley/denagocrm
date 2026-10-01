import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #22, custom fields + timeline pins: a thrown server-action Error
// reaches staff as the generic "This page hit an error" in production. These now
// return refusals and their forms show them.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const fn = (file: string, name: string) => {
  const s = src(file);
  const start = s.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = s.indexOf("\nexport async function ", start + 10);
  return s.slice(start, next === -1 ? undefined : next);
};

const WRITES: Array<[string, string[]]> = [
  ["src/app/actions/customFields.ts", ["saveCustomFieldDef", "deleteCustomFieldDef"]],
  ["src/app/actions/timelinePins.ts", ["toggleActivityPin", "toggleContactNotePin", "toggleLeadNotePin"]],
  ["src/app/actions/communications.ts", ["toggleCommunicationPin"]],
];

for (const [file, names] of WRITES) {
  for (const name of names) {
    test(`${name} returns its refusal instead of throwing`, () => {
      const body = fn(file, name);
      assert.match(body, /return asActionResult\(async \(\) => \{/);
      assert.doesNotMatch(body, /throw new Error\(/);
      assert.doesNotMatch(body, /findUniqueOrThrow\(/, "a missing row is a refusal, not a crash");
      assert.doesNotMatch(body, /^\s+if \([^)]*\) return;$/m, "a bare return reads as success");
    });
  }
}

test("the forms show the messages", () => {
  const page = src("src/app/(app)/settings/custom-fields/page.tsx");
  assert.match(page, /<SaveForm action=\{saveCustomFieldDef\} resetOnSuccess=\{isNew\}/);
  assert.doesNotMatch(page, /<form[^>]*\baction=\{/);
  const timeline = src("src/components/LeadTimeline.tsx");
  assert.match(timeline, /<SaveForm action=\{pinAction\}/);
  assert.doesNotMatch(timeline, /<form action=\{pinAction\}/);
});
