import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  defaultEntryStageId,
  formDetailStorageKey,
  readFormDetailMode,
  writeFormDetailMode,
  type EntryStageOption,
} from "../src/lib/createFormDetail";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The compact create forms: what is remembered, what is folded, and which
 * stage a new lead lands in when nobody picks one.
 */

class FakeStorage {
  readonly data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

class ThrowingStorage {
  getItem(): string | null {
    throw new Error("blocked");
  }
  setItem(): void {
    throw new Error("blocked");
  }
}

test("compact is the default: absent, corrupted or foreign values all land there", () => {
  const storage = new FakeStorage();
  assert.equal(readFormDetailMode(storage, "lead"), "compact");
  storage.setItem(formDetailStorageKey("lead"), "yes please");
  assert.equal(readFormDetailMode(storage, "lead"), "compact");
  assert.equal(readFormDetailMode(null, "lead"), "compact");
  assert.equal(readFormDetailMode(undefined, "lead"), "compact");
});

test("the choice round-trips", () => {
  const storage = new FakeStorage();
  writeFormDetailMode(storage, "lead", "expanded");
  assert.equal(readFormDetailMode(storage, "lead"), "expanded");
  writeFormDetailMode(storage, "lead", "compact");
  assert.equal(readFormDetailMode(storage, "lead"), "compact");
});

test("a storage that throws (private window, blocked site data) neither throws nor changes the default", () => {
  const storage = new ThrowingStorage();
  assert.doesNotThrow(() => writeFormDetailMode(storage, "lead", "expanded"));
  assert.equal(readFormDetailMode(storage, "lead"), "compact");
});

/** The JSX between two markers of the RENDERED form — what is actually shown vs folded. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers moved: ${from} … ${to}`);
  return source.slice(start, end);
}

test("compact lead form: the essentials are on screen, and a value that saves is never folded", () => {
  const form = src("src/components/LeadForm.tsx");
  const essentials = between(form, 'title="Essentials"', "<FormDetailDisclosure");
  for (const field of ["contactField", "nameField", "phoneField", "emailField", "productField", "quantityField", "valueField"]) {
    assert.ok(essentials.includes(`{${field}}`), `${field} must be in the compact section`);
  }
  // Picking a product fills the value; folding it would save a figure nobody saw.
  const folded = between(form, "const detailSections = (", "return (");
  assert.ok(!folded.includes("{valueField}"), "the value must not be in the folded section");
  // A folded required control blocks submit with a message pointing nowhere.
  assert.match(form, /required=\{showDetail\}/);
  // Every name createLead reads is still posted by the form.
  const action = src("src/app/actions/leads.ts");
  for (const name of ["contactId", "name", "phone", "email", "productId", "quantity", "value", "stageId", "source", "assignedToId", "notes"]) {
    assert.ok(action.includes(`"${name}"`), `createLead no longer reads ${name}`);
    assert.ok(form.includes(`name="${name}"`), `LeadForm no longer posts ${name}`);
  }
});

test("job card form folds nothing: arrival mileage is always asked on a vehicle job", () => {
  const form = src("src/components/JobCardForm.tsx");
  assert.ok(!form.includes("FormDetailDisclosure"), "the job card form must not fold fields");
  assert.match(form, /name="kmIn"/);
  assert.match(src("src/app/actions/jobcards.ts"), /formData\.get\("kmIn"\)/);
});

test("every new-lead form lists live pipelines' stages with closed ones flagged", () => {
  assert.match(src("src/app/(app)/leads/new/page.tsx"), /listEntryStages\(\)/);
  assert.match(src("src/app/api/quick-create/route.ts"), /listEntryStages\(\)/);
  assert.match(src("src/components/QuickCreateDialog.tsx"), /defaultPipelineId=\{currentOptions\.defaultPipelineId\}/);
  // The board's dialog lists the board's own pipeline; it flags won/lost.
  assert.match(src("src/app/(app)/leads/page.tsx"), /isClosed: stageMeta\.get\(stage\.id\)\?\.isClosed/);
  const lib = src("src/lib/pipelines.ts");
  assert.match(between(lib, "export async function listEntryStages", "export async function listPipelineStages"), /listActiveSalesPipelines\(\)/);
});

const stages: EntryStageOption[] = [
  // Order-0 across pipelines: the service pipeline's first stage sorts before sales'.
  { id: "svc-triage", name: "Triage", pipelineId: "service", isClosed: false },
  { id: "sales-new", name: "New", pipelineId: "sales", isClosed: false },
  { id: "sales-qualified", name: "Qualified", pipelineId: "sales", isClosed: false },
  { id: "sales-won", name: "Won", pipelineId: "sales", isClosed: true },
];

test("default stage: the first open stage of the default pipeline, not the first row", () => {
  assert.equal(defaultEntryStageId(stages, "sales"), "sales-new");
});

test("default stage: a closed stage is never the default, even when it sorts first", () => {
  const closedFirst: EntryStageOption[] = [
    { id: "won", name: "Won", pipelineId: "sales", isClosed: true },
    { id: "new", name: "New", pipelineId: "sales", isClosed: false },
  ];
  assert.equal(defaultEntryStageId(closedFirst, "sales"), "new");
});

test("default stage: an unknown default pipeline falls back to the first open stage anywhere", () => {
  assert.equal(defaultEntryStageId(stages, "archived"), "svc-triage");
  assert.equal(defaultEntryStageId(stages, null), "svc-triage");
  assert.equal(defaultEntryStageId(stages), "svc-triage");
});

test("default stage: callers that list plain {id, name} stages still get the first one", () => {
  assert.equal(defaultEntryStageId([{ id: "a", name: "A" }, { id: "b", name: "B" }]), "a");
  assert.equal(defaultEntryStageId([]), "");
  // Nothing open at all: the required select is still given a value rather than left empty.
  assert.equal(defaultEntryStageId([{ id: "won", name: "Won", isClosed: true }]), "won");
});

test("the create pages opt in; the edit dialog keeps the full form", () => {
  assert.ok(src("src/app/(app)/leads/new/page.tsx").includes('detail="collapsible"'));
  assert.ok(src("src/app/(app)/jobcards/new/page.tsx").includes('detail="compact"'));
  assert.ok(!src("src/app/(app)/leads/[id]/page.tsx").includes('detail="collapsible"'));
});
