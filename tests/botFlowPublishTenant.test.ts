import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { legacyFlowTenant } from "../src/lib/flowTenantScope";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Publish was silently dead for every flow created since the 20260722146000
 * backfill.
 *
 * BotFlow.tenantId is nullable, `prisma.botFlow.create` did not stamp it, and the
 * db.ts guard stamps nothing while enforcement is dormant — so those rows carry
 * NULL. The publish transaction re-read the draft with a STRICT `{ id, tenantId }`
 * filter, found nothing, and threw FLOW_NOT_FOUND, which setActiveFlow catches
 * into null. The operator clicked Publish and got no audit, no revalidate and no
 * error: nothing happened at all.
 */

test("the founding tenant owns legacy NULL-tenant rows; a second tenant sees only its own", () => {
  const founding = legacyFlowTenant(DEFAULT_TENANT_ID) as { OR?: unknown[] };
  assert.ok(Array.isArray(founding.OR), "the founding tenant must also match tenantless rows");
  assert.deepEqual(founding.OR, [{ tenantId: DEFAULT_TENANT_ID }, { tenantId: null }]);

  const second = legacyFlowTenant("tenant_other") as { tenantId?: string; OR?: unknown[] };
  assert.equal(second.tenantId, "tenant_other");
  assert.equal(second.OR, undefined, "a second workspace must never inherit the tenantless rows");
});

test("publish reads and writes the draft with the same rule the runtime reads it with", () => {
  const code = src("src/lib/flowPublishing.ts");
  const publish = code.slice(code.indexOf("export async function publishFlowSnapshot"));

  // The re-read, the deactivate sweep and the activate must all tolerate a legacy
  // NULL tenant — a strict filter on any one of them reintroduces the dead button
  // or leaves the previous flow live alongside the new one.
  const strict = publish.match(/where: \{[^}]*\btenantId\b(?!\s*:\s*null)[^}]*\}/g) ?? [];
  const offenders = strict.filter((w) => !w.includes("legacyFlowTenant") && !w.includes("tenantId_channel") && !w.includes("flowId"));
  assert.deepEqual(offenders, [], `these publish filters would miss legacy NULL-tenant flows:\n  ${offenders.join("\n  ")}`);

  assert.match(publish, /legacyFlowTenant\(tenantId\)/, "publish must use the shared legacy rule");
  // And it should shrink the problem rather than perpetuate it.
  assert.match(publish, /data: \{ active: true, tenantId \}/, "publishing stamps the owner it now knows");
});

test("a newly created flow is not born tenantless", () => {
  // The root cause. If creation stamps the tenant, the legacy rule stops needing
  // to grow new exceptions.
  const actions = src("src/app/actions/flow.ts");
  const creates = actions.match(/botFlow\.create\(\{[\s\S]*?\}\)/g) ?? [];
  assert.ok(creates.length >= 2, `expected the create sites, found ${creates.length}`);
  for (const create of creates) {
    assert.match(create, /tenantId: writeTenantId\(\) \?\? DEFAULT_TENANT_ID/, `a create still writes a tenantless flow:\n${create}`);
  }
});
