import assert from "node:assert/strict";
import test from "node:test";
import { decryptSignToken, encryptSignToken, hashSignToken, isValidSignToken, newSignToken, safeTokenEqual } from "../src/lib/signing/tokens";

test("signing capabilities are high entropy and stored as one-way digests", () => {
  const token = newSignToken();
  assert.match(token, /^[a-f0-9]{56}$/);
  assert.equal(isValidSignToken(token), true);
  assert.match(hashSignToken(token), /^[a-f0-9]{64}$/);
  assert.notEqual(hashSignToken(token), token);
});

test("recoverable delivery copy uses authenticated encryption", () => {
  const prior = process.env.SIGNING_TOKEN_ENCRYPTION_KEY;
  process.env.SIGNING_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    const token = newSignToken();
    const encrypted = encryptSignToken(token);
    assert.match(encrypted, /^v1:/);
    assert.equal(decryptSignToken(encrypted), token);
    const tampered = encrypted.slice(0, -1) + (encrypted.endsWith("A") ? "B" : "A");
    assert.throws(() => decryptSignToken(tampered));
  } finally {
    if (prior == null) delete process.env.SIGNING_TOKEN_ENCRYPTION_KEY;
    else process.env.SIGNING_TOKEN_ENCRYPTION_KEY = prior;
  }
});

test("constant-time comparison rejects different values and lengths", () => {
  assert.equal(safeTokenEqual("a".repeat(64), "a".repeat(64)), true);
  assert.equal(safeTokenEqual("a".repeat(64), "b".repeat(64)), false);
  assert.equal(safeTokenEqual("a", "aa"), false);
});
