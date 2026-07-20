import assert from "node:assert/strict";
import test from "node:test";
import { getSearchDestinations, matchSearchDestinations } from "../src/lib/search-destinations";

test("finds Settings destinations by their visible labels", () => {
  const destinations = getSearchDestinations({ modules: "", isAdmin: true });
  const results = matchSearchDestinations("backup", destinations);

  assert.equal(results[0]?.label, "Backup & recovery");
  assert.equal(results[0]?.href, "/settings/backup-recovery");
});

test("finds the Document library in the sidebar (available to everyone)", () => {
  const destinations = getSearchDestinations({ modules: "", isAdmin: true });
  const results = matchSearchDestinations("document library", destinations);

  assert.equal(results[0]?.label, "Document library");
  assert.equal(results[0]?.href, "/library");
});

test("finds Settings destinations by descriptive keywords", () => {
  const destinations = getSearchDestinations({ modules: "", isAdmin: true });

  assert.equal(matchSearchDestinations("restore", destinations)[0]?.href, "/settings/backup-recovery");
  assert.equal(matchSearchDestinations("document studio", destinations)[0]?.href, "/document-studio");
});

test("does not expose administrator Settings destinations to members", () => {
  const destinations = getSearchDestinations({ modules: "crm", isAdmin: false });

  // Admin-only Settings sections stay hidden from members…
  assert.equal(matchSearchDestinations("security", destinations).length, 0);
  assert.equal(matchSearchDestinations("backup", destinations).length, 0);
  assert.equal(matchSearchDestinations("settings", destinations)[0]?.href, "/settings");
  // …but the Document library is a general sidebar destination, open to everyone.
  assert.equal(matchSearchDestinations("document library", destinations)[0]?.href, "/library");
});
