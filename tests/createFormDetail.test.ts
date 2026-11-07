import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  CREATE_FORM_FIELDS,
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
  assert.equal(readFormDetailMode(undefined, "jobcard"), "compact");
});

test("the choice round-trips, per form", () => {
  const storage = new FakeStorage();
  writeFormDetailMode(storage, "lead", "expanded");
  assert.equal(readFormDetailMode(storage, "lead"), "expanded");
  // A rep who wants the long lead form has said nothing about job cards.
  assert.equal(readFormDetailMode(storage, "jobcard"), "compact");
  writeFormDetailMode(storage, "lead", "compact");
  assert.equal(readFormDetailMode(storage, "lead"), "compact");
});

test("a storage that throws (private window, blocked site data) neither throws nor changes the default", () => {
  const storage = new ThrowingStorage();
  assert.doesNotThrow(() => writeFormDetailMode(storage, "lead", "expanded"));
  assert.equal(readFormDetailMode(storage, "lead"), "compact");
});

test("compact and detail groups split one contract: no field is in both, none is dropped", () => {
  for (const [form, groups] of Object.entries(CREATE_FORM_FIELDS)) {
    const all = [...groups.compact, ...groups.detail];
    assert.equal(new Set(all).size, all.length, `${form}: a field is listed twice`);
    for (const name of groups.compact) assert.ok(!groups.detail.includes(name), `${form}: ${name} is in both groups`);
  }
  // Every name the action reads is somewhere on the form, and vice versa.
  const leadAction = src("src/app/actions/leads.ts");
  for (const name of [...CREATE_FORM_FIELDS.lead.compact, ...CREATE_FORM_FIELDS.lead.detail]) {
    assert.ok(leadAction.includes(`"${name}"`), `createLead no longer reads ${name}`);
  }
  const jobcardAction = src("src/app/actions/jobcards.ts");
  for (const name of [...CREATE_FORM_FIELDS.jobcard.compact, ...CREATE_FORM_FIELDS.jobcard.detail]) {
    assert.ok(jobcardAction.includes(`formData.get("${name}")`), `createJobCard no longer reads ${name}`);
  }
  // And the forms post them under the same names.
  const leadForm = src("src/components/LeadForm.tsx");
  for (const name of [...CREATE_FORM_FIELDS.lead.compact, ...CREATE_FORM_FIELDS.lead.detail]) {
    assert.ok(leadForm.includes(`name="${name}"`), `LeadForm no longer posts ${name}`);
  }
  const jobCardForm = src("src/components/JobCardForm.tsx");
  for (const name of [...CREATE_FORM_FIELDS.jobcard.compact, ...CREATE_FORM_FIELDS.jobcard.detail]) {
    assert.ok(jobCardForm.includes(`name="${name}"`), `JobCardForm no longer posts ${name}`);
  }
});

test("the compact lead form is the 80% case: who, how to reach them, what, where it goes", () => {
  assert.deepEqual(
    [...CREATE_FORM_FIELDS.lead.compact],
    ["contactId", "name", "phone", "email", "productId", "quantity", "source", "assignedToId"],
  );
  assert.deepEqual([...CREATE_FORM_FIELDS.jobcard.compact], ["vehicleId", "contactId", "description", "priority"]);
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
  assert.ok(src("src/app/(app)/jobcards/new/page.tsx").includes('detail="collapsible"'));
  assert.ok(!src("src/app/(app)/leads/[id]/page.tsx").includes('detail="collapsible"'));
});
