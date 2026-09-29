import assert from "node:assert/strict";
import test from "node:test";
import { getSearchDestinations, matchSearchDestinations } from "../src/lib/search-destinations";

test("finds Settings destinations by their visible labels", () => {
  const destinations = getSearchDestinations({ isAdmin: true });
  const results = matchSearchDestinations("backup", destinations);

  assert.equal(results[0]?.label, "Backup & recovery");
  assert.equal(results[0]?.href, "/settings/backup-recovery");
});

test("finds the Document library, now part of Documents, for users with library access", () => {
  const destinations = getSearchDestinations({ isAdmin: true });
  const results = matchSearchDestinations("document library", destinations);

  assert.equal(results[0]?.label, "Documents");
  assert.equal(results[0]?.href, "/documents");

  // Library access alone still finds it: the page opens such a user on the Library.
  const libraryOnly = getSearchDestinations({ isAdmin: false, permissions: ["library.view"] });
  assert.equal(matchSearchDestinations("price lists", libraryOnly)[0]?.href, "/documents");
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
