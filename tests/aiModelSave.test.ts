import assert from "node:assert/strict";
import { test } from "node:test";
import Module from "node:module";

/*
 * Review of #1154: the picker's provider and model are saved together or not at all. The two writes run here against
 * a stand-in transaction with Postgres's semantics — writes made through `tx` are kept only if the callback resolves —
 * and a model write that fails must leave the provider as it was.
 */

const store = new Map<string, string>();
const state = { failOn: null as string | null, txSeen: [] as unknown[] };

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: Loader };
const realLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  if (request === "./db") {
    return {
      basePrisma: {
        $transaction: async (fn: (tx: Map<string, string>) => Promise<void>) => {
          const staged = new Map<string, string>();
          await fn(staged); // throws → nothing below runs: the staged writes are discarded
          for (const [k, v] of staged) store.set(k, v);
        },
      },
    };
  }
  if (request === "./settings") {
    return {
      putSetting: async (key: string, value: string, tx?: Map<string, string>) => {
        state.txSeen.push(tx);
        if (!tx) throw new Error(`${key} written outside the transaction`);
        if (key === state.failOn) throw new Error("database refused the write");
        tx.set(key, value);
      },
    };
  }
  if (request === "./codex") return { CODEX_MODEL_KEY: "CODEX_MODEL" };
  return realLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { saveAiChoice } = require("../src/lib/aiModelSave") as typeof import("../src/lib/aiModelSave");

test("both are saved together, each through the one transaction", async () => {
  store.clear();
  state.failOn = null;
  state.txSeen = [];
  await saveAiChoice({ provider: "claude", model: "claude-opus-5-5" });
  assert.deepEqual(Object.fromEntries(store), { AI_PROVIDER: "claude", AI_CLAUDE_MODEL: "claude-opus-5-5" });
  assert.equal(state.txSeen.length, 2);
  assert.equal(state.txSeen[0], state.txSeen[1], "the same transaction for both writes");
});

test("the model write fails → the provider is NOT switched (rolled back), and the save reports the failure", async () => {
  store.clear();
  store.set("AI_PROVIDER", "chatgpt");
  store.set("AI_CLAUDE_MODEL", "");
  state.failOn = "AI_CLAUDE_MODEL";
  await assert.rejects(saveAiChoice({ provider: "claude", model: "claude-opus-5-5" }), /refused/);
  assert.deepEqual(Object.fromEntries(store), { AI_PROVIDER: "chatgpt", AI_CLAUDE_MODEL: "" }, "still ChatGPT: no paid Claude on a stale model");

  state.failOn = "CODEX_MODEL";
  await assert.rejects(saveAiChoice({ provider: "chatgpt", model: "gpt-6-sol" }));
  assert.equal(store.get("AI_PROVIDER"), "chatgpt");
  assert.equal(store.has("CODEX_MODEL"), false);
});
