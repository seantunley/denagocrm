import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(process.cwd(), "src", "components", "LocationAutocomplete.tsx"),
  "utf8",
);

test("location autocomplete keeps a native form input on mobile", () => {
  assert.match(source, /<input[\s\S]+name=\{name\}/);
  assert.match(source, /role="combobox"/);
  assert.match(source, /role="listbox"/);
  assert.doesNotMatch(source, /PlaceAutocompleteElement/);
});

test("mobile place suggestions use the supported Autocomplete Data API", () => {
  assert.match(source, /AutocompleteSuggestion\.fetchAutocompleteSuggestions/);
  assert.match(source, /new library\.AutocompleteSessionToken\(\)/);
  assert.match(source, /includedRegionCodes: \["za"\]/);
  assert.match(source, /onPointerDown=\{\(event\) => \{/);
  assert.match(source, /touch-manipulation/);
});

test("autocomplete location bias stays inside Google's circle radius limit", () => {
  assert.match(source, /CAPE_TOWN_AUTOCOMPLETE_RADIUS_METRES = 50_000/);
  assert.doesNotMatch(source, /radius:\s*100_000/);
});

test("ordinary browser referrers are preserved", () => {
  assert.doesNotMatch(source, /auth_referrer_policy/);
});
