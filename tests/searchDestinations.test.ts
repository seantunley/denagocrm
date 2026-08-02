import assert from "node:assert/strict";
import test from "node:test";
import { getSearchDestinations, matchSearchDestinations } from "../src/lib/search-destinations";

test("finds Settings destinations by their visible labels", () => {
  const destinations = getSearchDestinations({ isAdmin: true });
  const results = matchSearchDestinations("backup", destinations);

  assert.equal(results[0]?.label, "Backup & recovery");
  assert.equal(results[0]?.href, "/settings/backup-recovery");
});

test("finds the Document library for users with library access", () => {
  const destinations = getSearchDestinations({ isAdmin: true });
  const results = matchSearchDestinations("document library", destinations);

  assert.equal(results[0]?.label, "Document library");
  assert.equal(results[0]?.href, "/library");
});

test("finds Settings destinations by descriptive keywords", () => {
  const destinations = getSearchDestinations({ isAdmin: true });

  assert.equal(matchSearchDestinations("restore", destinations)[0]?.href, "/settings/backup-recovery");
  assert.equal(matchSearchDestinations("document studio", destinations)[0]?.href, "/document-studio");
});

test("does not expose administrator Settings destinations to members", () => {
  const destinations = getSearchDestinations({ isAdmin: false });

  // Admin-only Settings sections stay hidden from members…
  assert.equal(matchSearchDestinations("security", destinations).length, 0);
  assert.equal(matchSearchDestinations("backup", destinations).length, 0);
  assert.equal(matchSearchDestinations("settings", destinations)[0]?.href, "/settings");
  // …and the Document library link is gated by library.view/manage, so a member
  // without that permission doesn't see it as a destination either.
  assert.equal(matchSearchDestinations("document library", destinations).length, 0);
});
