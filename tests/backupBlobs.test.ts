import test from "node:test";
import assert from "node:assert/strict";
import {
  activeStore,
  activeStoreToken,
  activeWriteTokenPresent,
  dedupeByPathname,
} from "../src/lib/backupBlobs";

const BOTH = { publicToken: "pub", privateToken: "priv" };

test("activeStore: private iff BLOB_PRIVATE is on", () => {
  assert.equal(activeStore(false), "public");
  assert.equal(activeStore(true), "private");
});

test("activeStoreToken: writes/existence use the active store's token — no cross-store", () => {
  // Flag off with BOTH tokens installed (the pre-cutover rollout state):
  // the active token is still the PUBLIC one, so behaviour can't cross stores.
  assert.equal(activeStoreToken(false, BOTH), "pub");
  assert.equal(activeStoreToken(true, BOTH), "priv");
  // Public-only and private-only setups pick the one that exists for their mode.
  assert.equal(activeStoreToken(false, { publicToken: "pub" }), "pub");
  assert.equal(activeStoreToken(true, { privateToken: "priv" }), "priv");
});

test("activeWriteTokenPresent: fails closed when the active store's token is missing", () => {
  assert.equal(activeWriteTokenPresent(true, { publicToken: "pub" }), false); // private mode, no private token
  assert.equal(activeWriteTokenPresent(false, { privateToken: "priv" }), false); // public mode, no public token
  assert.equal(activeWriteTokenPresent(true, BOTH), true);
  assert.equal(activeWriteTokenPresent(false, BOTH), true);
  // Post-cutover: public token retired, private mode still works.
  assert.equal(activeWriteTokenPresent(true, { privateToken: "priv" }), true);
});

test("dedupeByPathname: duplicate pathname across stores keeps the first (public) occurrence", () => {
  const pub = [{ pathname: "backups/assets/abc.bin.enc", url: "pub-url" }];
  const priv = [
    { pathname: "backups/assets/abc.bin.enc", url: "priv-url" },
    { pathname: "backups/database/x.json.enc", url: "priv-db" },
  ];
  const merged = dedupeByPathname(pub, priv);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((b) => b.pathname.includes("abc"))?.url, "pub-url");
  assert.ok(merged.some((b) => b.pathname.includes("database")));
});
