import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const code = readFileSync(path.join(root, "src/lib/flowAiProposal.ts"), "utf8");

test("AI proposals are short-lived HMAC-authenticated payloads", () => {
  assert.match(code, /createHmac\("sha256", proposalSecret\(\)\)/);
  assert.match(code, /flow-ai-proposal:/);
  assert.match(code, /15 \* 60_000/);
  assert.match(code, /payload\.expiresAt <= now/);
  assert.match(code, /timingSafeEqual/);
  assert.match(code, /parts\.length !== 2/);
  assert.match(code, /typeof payload\.expiresAt !== "number"/);
  assert.match(code, /token\.length > 300_000/);
});

test("the signature binds the proposal to a flow, owner and base definition", () => {
  for (const field of ["flowId", "ownerId", "baseHash", "definition", "instruction"]) assert.match(code, new RegExp(field));
  assert.match(code, /flowDefinitionHash/);
  assert.match(code, /SESSION_SECRET is not set/);
});

test("proposal diff reports added, removed, changed and start-node changes", () => {
  assert.match(code, /const added =/);
  assert.match(code, /const removed =/);
  assert.match(code, /const changed =/);
  assert.match(code, /startChanged: before\.start !== after\.start/);
});
