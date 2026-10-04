import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import Module from "node:module";

/**
 * Tenant-fit audit 2.3: `writeTenantId() ?? DEFAULT_TENANT_ID` filed any write
 * that named no workspace in Denago's. Under enforcement that is only reachable
 * from a trusted system scope, and there it must refuse; with enforcement off
 * (local dev, tests) the founding workspace stays the answer.
 */

// tenantWrite reaches `server-only` and a live Prisma client; neither is under test.
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: Loader };
const realLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  if (request === "./db") return { basePrisma: {} };
  return realLoad.call(this, request, parent, isMain);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ownedWriteTenantId, inheritedTenantId } = require("../src/lib/tenantWrite") as typeof import("../src/lib/tenantWrite");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runInTenantScope } = require("../src/lib/tenantScope") as typeof import("../src/lib/tenantScope");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __setTenantEnforcingForTests } = require("../src/lib/tenantEnforcement") as typeof import("../src/lib/tenantEnforcement");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DEFAULT_TENANT_ID } = require("../src/lib/tenant") as typeof import("../src/lib/tenant");

const system = <T>(fn: () => T) => runInTenantScope({ tenantId: null, system: true }, async () => fn());
const workspace = <T>(fn: () => T) => runInTenantScope({ tenantId: "tenant_b", system: false }, async () => fn());

test("enforcing: a workspace scope owns the write; a system scope must name one", async (t) => {
  __setTenantEnforcingForTests(true);
  t.after(() => __setTenantEnforcingForTests(null));
  assert.equal(await workspace(() => ownedWriteTenantId()), "tenant_b");
  await assert.rejects(system(() => ownedWriteTenantId()), /must name the workspace/);
  // A parent record still decides, even from a system scope.
  assert.equal(await system(() => inheritedTenantId("tenant_c")), "tenant_c");
  await assert.rejects(system(() => inheritedTenantId(null)), /must name the workspace/);
});

test("dormant: the founding workspace stays the stand-in", () => {
  __setTenantEnforcingForTests(false);
  try {
    assert.equal(ownedWriteTenantId(), DEFAULT_TENANT_ID);
    assert.equal(inheritedTenantId(null), DEFAULT_TENANT_ID);
  } finally {
    __setTenantEnforcingForTests(null);
  }
});

test("no runtime writer falls back to the founding workspace by hand", () => {
  for (const file of [
    "botFlowAnalytics", "botFlowAnalyticsReport", "commentThreads", "journeyTenant", "leadCreate",
    "messenger", "repairs", "statistics", "whatsapp", "metaLeadSync", "googleReviews", "inboxCollaboration",
  ]) {
    const code = readFileSync(new URL(`../src/lib/${file}.ts`, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\?\? DEFAULT_TENANT_ID/, file);
  }
});
