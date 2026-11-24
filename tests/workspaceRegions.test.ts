import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SOUTH_AFRICAN_PROVINCES, parseRegions, regionChoices, regionLabel, regionsOrDefault } from "../src/lib/regionRules";

// Sean, 2026-11-24: "Provinces: Yes, editable" — each workspace keeps its own list (Settings → Regions).

test("a list is one per line, tidied, deduplicated in any case, order kept", () => {
  assert.deepEqual(parseRegions("  Ontario \n\nquebec\nOntario\n  British   Columbia"), ["Ontario", "quebec", "British Columbia"]);
});

test("no saved list: South Africa's provinces for a rand workspace, none for any other", () => {
  assert.deepEqual(regionsOrDefault(null, null), SOUTH_AFRICAN_PROVINCES);
  assert.deepEqual(regionsOrDefault(null, "ZAR"), SOUTH_AFRICAN_PROVINCES);
  assert.deepEqual(regionsOrDefault(null, "GBP"), []);
  assert.deepEqual(regionsOrDefault("Kent\nEssex", "ZAR"), ["Kent", "Essex"]);
});

test("the field is named by the workspace, with a sensible default", () => {
  assert.equal(regionLabel(null, "ZAR"), "Province");
  assert.equal(regionLabel(null, "USD"), "Region");
  assert.equal(regionLabel("  State ", "USD"), "State");
});

test("a contact keeps a value the list no longer has", () => {
  assert.deepEqual(regionChoices(["Kent"], "Gauteng"), ["Kent", "Gauteng"]);
  assert.deepEqual(regionChoices(["Kent"], "kent"), ["Kent"]);
  assert.deepEqual(regionChoices([], null), []);
});

test("no screen carries its own province list, and settings are read for the named workspace", () => {
  for (const file of ["src/components/ContactForm.tsx", "src/components/SegmentBuilder.tsx", "src/components/marketing/AudienceWorkspace.tsx"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /Western Cape/, file);
  }
  const loader = readFileSync("src/lib/regions.ts", "utf8");
  assert.doesNotMatch(loader, /getSetting\(/);
  assert.match(readFileSync("src/app/actions/regions.ts", "utf8"), /putWorkspaceSetting\(tenantId, REGIONS_KEY/);
});
