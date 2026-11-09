import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { journeyModuleProblems, missingModule, STEP_MODULE, stepTypesIn, TRIGGER_MODULE } from "../src/lib/journeyModules";
import { JOURNEY_TRIGGERS } from "../src/lib/journeyTypes";

/** Sean, 2026-11-09: "are automotive triggers removed when automotive module in not selected?" — now they are. */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const label = { trigger: (t: string) => t, step: (s: string) => s };

test("every automotive trigger is mapped, and only real triggers are", () => {
  for (const type of ["job_completed", "vehicle_delivered", "test_drive_booked", "test_drive_completed", "test_drive_no_show", "delivered", "delivery_scheduled", "purchase_anniversary", "win_back", "service_due"]) {
    assert.equal(TRIGGER_MODULE[type], "automotive", type);
  }
  for (const type of Object.keys(TRIGGER_MODULE)) assert.ok((JOURNEY_TRIGGERS as readonly string[]).includes(type), type);
  assert.equal(STEP_MODULE.send_service_reminder, "automotive");
  assert.equal(missingModule(TRIGGER_MODULE.lead_created, new Set()), null, "core triggers need nothing");
});

test("nested steps are found — a service reminder inside a branch still needs Automotive", () => {
  const definition = { steps: [{ id: "c", type: "choose", config: { options: [{ steps: [{ id: "r", type: "send_service_reminder", config: {} }] }] } }] };
  assert.ok(stepTypesIn(definition).has("send_service_reminder"));
  const off = journeyModuleProblems([{ type: "delivery_scheduled" }], definition, new Set(["marketing"]), label);
  assert.equal(off.length, 2);
  assert.match(off[0], /needs the Automotive \/ Workshop module/);
  assert.deepEqual(journeyModuleProblems([{ type: "delivery_scheduled" }], definition, new Set(["automotive"]), label), []);
});

test("the builder, the publish action and the scheduler all read the one map", () => {
  const builder = read("src/components/JourneyBuilder.tsx");
  assert.match(builder, /JOURNEY_TRIGGERS\.filter\(\(type\) => !triggerBlocked\(type\) \|\| type === spec\.type\)/);
  assert.match(builder, /\.filter\(\(\[value\]\) => !blocked\(value\) \|\| value === step\.type\)/);
  assert.match(read("src/components/JourneyCanvas.tsx"), /\.filter\(\(type\) => !stepBlocked\(type\)\)/);
  assert.match(read("src/app/(app)/journeys/page.tsx"), /enabledModules: \[\.\.\.\(await getEnabledModuleIds\(\)\)\]/);
  const publish = read("src/app/actions/journeys.ts");
  assert.match(publish, /journeyModuleProblems\(readJourneyTriggers\(draft\.triggers\), draft\.definition, await getEnabledModuleIds\(\)/);
  assert.match(publish, /if \(moduleProblems\.length\) refuse\(moduleProblems\.join\(" "\)\);/);
  const scheduler = read("src/lib/journeyScheduling.ts");
  assert.match(scheduler, /const needs = TRIGGER_MODULE\[spec\.type\];\s*if \(needs && !\(await isModuleEnabled\(needs\)\)\) return created;/);
});
