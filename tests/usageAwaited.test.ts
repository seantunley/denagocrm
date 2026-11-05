import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Module from "node:module";

/*
 * Review of #1002: AI calls metered with `void recordAiUsage(...)`, so the billing write was left running after the
 * caller returned — and on serverless it can be cut off when the response finishes. Chargeable usage must be written
 * before the call that caused it completes.
 */

let releaseWrite: () => void = () => {};
const writes: string[] = [];
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: Loader };
const realLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  if (request === "./db") {
    return {
      basePrisma: {
        // A slow database: the write lands only when the test releases it.
        $executeRaw: () => new Promise<number>((resolve) => { releaseWrite = () => { writes.push("counted"); resolve(1); }; }),
      },
    };
  }
  return realLoad.call(this, request, parent, isMain);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { recordUsage } = require("../src/lib/usage") as typeof import("../src/lib/usage");

test("recordUsage resolves only after the counter is written", async () => {
  let done = false;
  const call = recordUsage({ ai_usd_micros: 1200, ai_calls: 1 }, "tenant_a").then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(done, false, "still waiting on the database");
  releaseWrite();
  await call;
  assert.deepEqual(writes, ["counted"]);
  assert.equal(done, true);
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("every chargeable usage write is awaited, never fired and forgotten", () => {
  const health = readFileSync("src/lib/systemHealth.ts", "utf8");
  assert.match(health, /await recordUsage\(\{ ai_usd_micros: aiCostMicros\(usage, model\), ai_calls: 1 \}\)/);
  const offenders = sources("src").filter((path) => /\bvoid\s+record(Ai)?Usage\(|record(Ai)?Usage\([^)]*\)\s*\.catch\(/.test(readFileSync(path, "utf8")));
  assert.deepEqual(offenders, [], "metering must be awaited");
  const callers = sources("src").filter((path) => readFileSync(path, "utf8").includes("recordAiUsage(json.usage"));
  assert.ok(callers.length >= 6, "the AI callers are still found");
  for (const path of callers) {
    const calls = readFileSync(path, "utf8").match(/\S+ recordAiUsage\(json\.usage/g) ?? [];
    for (const call of calls) assert.equal(call, "await recordAiUsage(json.usage", path);
  }
});
