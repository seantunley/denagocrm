import assert from "node:assert/strict";
import test from "node:test";
import { getSearchDestinations, matchSearchDestinations } from "../src/lib/search-destinations";

test("finds Settings destinations by their visible labels", () => {
  const destinations = getSearchDestinations({ modules: "", isAdmin: true });
  const results = matchSearchDestinations("library", destinations);

  assert.equal(results[0]?.label, "Library");
  assert.equal(results[0]?.href, "/settings?tab=library");
});

test("finds Settings destinations by descriptive keywords", () => {
  const destinations = getSearchDestinations({ modules: "", isAdmin: true });

  assert.equal(matchSearchDestinations("restore", destinations)[0]?.href, "/settings/backup-recovery");
  assert.equal(matchSearchDestinations("document studio", destinations)[0]?.href, "/document-studio");
});

test("does not expose administrator Settings destinations to members", () => {
  const destinations = getSearchDestinations({ modules: "crm", isAdmin: false });

  assert.equal(matchSearchDestinations("library", destinations).length, 0);
  assert.equal(matchSearchDestinations("security", destinations).length, 0);
  assert.equal(matchSearchDestinations("settings", destinations)[0]?.href, "/settings");
});
