import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SOUTH_AFRICAN_PROVINCES, parseRegions, regionChoices, regionLabel, regionsInRules, regionsOrDefault, usesRegionRule, withKeptRegions } from "../src/lib/regionRules";

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

test("a saved audience's regions stay choosable after the list changes (review of #1215)", () => {
  const saved = {
    operator: "AND",
    rules: [
      { field: "province", operator: "equals", value: "Gauteng" },
      { operator: "OR", rules: [{ field: "province", operator: "in", value: ["Limpopo", "gauteng"] }, { field: "source", operator: "equals", value: "website" }] },
    ],
    exclusions: [{ field: "province", operator: "equals", value: "Free State" }],
  };
  const used = regionsInRules(saved);
  assert.deepEqual(used, ["Gauteng", "Limpopo", "gauteng", "Free State"]);
  // A region removed from the list stays, after the list.
  assert.deepEqual(withKeptRegions(["Kent"], used), ["Kent", "Gauteng", "Limpopo", "Free State"]);
  // A non-rand workspace with no list: the saved rule still has its field and values.
  assert.deepEqual(withKeptRegions(regionsOrDefault(null, "GBP"), used), ["Gauteng", "Limpopo", "Free State"]);
  // Nothing saved, no list: no region rule offered.
  assert.deepEqual(withKeptRegions([], regionsInRules({ operator: "AND", rules: [] })), []);

  const workspace = readFileSync("src/components/marketing/AudienceWorkspace.tsx", "utf8");
  assert.match(workspace, /audiences\.flatMap\(\(audience\) => regionsInRules\(audience\.ruleTree\)\),\s*audiences\.some\(\(audience\) => usesRegionRule\(audience\.ruleTree\)\),/);
  assert.match(workspace, /const regionOptions = withKeptRegions\(regions\.options, savedRegions\);/);
});

test("a saved region rule that names no region ('is empty') still opens as the region field (review of #1215)", () => {
  const empty = { operator: "AND", rules: [{ field: "province", operator: "is_empty" }] };
  const nestedNotEmpty = { operator: "AND", rules: [{ field: "source", operator: "equals", value: "website" }], exclusions: [{ operator: "OR", rules: [{ field: "province", operator: "is_not_empty" }] }] };
  assert.deepEqual(regionsInRules(empty), [], "it names no region…");
  assert.equal(usesRegionRule(empty), true, "…but it uses the field");
  assert.equal(usesRegionRule(nestedNotEmpty), true, "nested in an exclusion too");
  assert.equal(usesRegionRule({ operator: "AND", rules: [{ field: "source", operator: "equals", value: "website" }] }), false);
  // With no choices the field is kept LAST: a new rule starts on the first field and must not start on an empty select.
  const workspace = readFileSync("src/components/marketing/AudienceWorkspace.tsx", "utf8");
  assert.match(workspace, /if \(regionOptions\.length\) return \[region, \.\.\.fields\];\s*return regionInUse \? \[\.\.\.fields, region\] : fields;/);
});

test("no screen carries its own province list, and settings are read for the named workspace", () => {
  for (const file of ["src/components/ContactForm.tsx", "src/components/SegmentBuilder.tsx", "src/components/marketing/AudienceWorkspace.tsx"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /Western Cape/, file);
  }
  const loader = readFileSync("src/lib/regions.ts", "utf8");
  assert.doesNotMatch(loader, /getSetting\(/);
  assert.match(readFileSync("src/app/actions/regions.ts", "utf8"), /putWorkspaceSetting\(tenantId, REGIONS_KEY/);
});
