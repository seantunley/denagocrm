import assert from "node:assert/strict";
import { test } from "node:test";
import Module from "node:module";

/*
 * Review of #1002: with tenant enforcement off, the settings owner is always the founding workspace, so every
 * workspace was metered as Denago and used Denago's AI key whatever its plan said. The acting workspace now
 * decides in both modes; this runs the real resolver against a fake settings table in each.
 */

const FOUNDING = "tenant_denago_cpt";
const settingRows = new Map<string, string>([
  [`${FOUNDING}|ANTHROPIC_API_KEY`, "founding-key"],
  ["tenant_own|ANTHROPIC_API_KEY", "own-key"],
]);
const tenants: Record<string, { platformAi: boolean; active: boolean }> = {
  tenant_paid: { platformAi: true, active: true },
  tenant_byo: { platformAi: false, active: true },
  tenant_own: { platformAi: false, active: true },
  tenant_closed: { platformAi: true, active: false },
};

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: Loader };
const realLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  if (request === "./db") {
    return {
      basePrisma: {
        appSetting: {
          findUnique: async ({ where }: { where: { tenantId_key: { tenantId: string; key: string } } }) => {
            const value = settingRows.get(`${where.tenantId_key.tenantId}|${where.tenantId_key.key}`);
            return value ? { value } : null;
          },
        },
        tenant: { findUnique: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null },
      },
    };
  }
  return realLoad.call(this, request, parent, isMain);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getProviderKey, settingsTenantId } = require("../src/lib/settings") as typeof import("../src/lib/settings");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runInTenantScope } = require("../src/lib/tenantScope") as typeof import("../src/lib/tenantScope");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __setTenantEnforcingForTests } = require("../src/lib/tenantEnforcement") as typeof import("../src/lib/tenantEnforcement");

const as = <T>(tenantId: string, fn: () => Promise<T>) => runInTenantScope({ tenantId, system: false }, fn);

for (const enforcing of [true, false]) {
  test(`enforcement ${enforcing ? "on" : "off"}: each workspace gets only the key its plan allows`, async (t) => {
    __setTenantEnforcingForTests(enforcing);
    t.after(() => __setTenantEnforcingForTests(null));
    assert.equal(await as("tenant_byo", () => getProviderKey("ANTHROPIC_API_KEY")), null, "no platform AI → no founding key");
    assert.equal(await as("tenant_paid", () => getProviderKey("ANTHROPIC_API_KEY")), "founding-key");
    assert.equal(await as("tenant_own", () => getProviderKey("ANTHROPIC_API_KEY")), "own-key", "its own key wins");
    assert.equal(await as("tenant_closed", () => getProviderKey("ANTHROPIC_API_KEY")), null, "a closed workspace gets nothing");
    assert.equal(await as(FOUNDING, () => getProviderKey("ANTHROPIC_API_KEY")), "founding-key");
    assert.equal(await as("tenant_paid", () => settingsTenantId()), "tenant_paid", "usage is metered to the acting workspace");
  });
}

test("enforcement off, no workspace at all (cron, no session): the founding workspace", async (t) => {
  __setTenantEnforcingForTests(false);
  t.after(() => __setTenantEnforcingForTests(null));
  assert.equal(await settingsTenantId(), FOUNDING);
  assert.equal(await runInTenantScope({ tenantId: null, system: true }, () => settingsTenantId()), FOUNDING);
});
