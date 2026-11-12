import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Review of #1064: every custom-field read and write names its workspace. The
 * behaviour across two real workspaces (enforcement off and on) is
 * scripts/test-custom-fields-workspaces.ts; this pins the wiring.
 */
const src = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const values = src("src/lib/customFieldValues.ts");
const actions = src("src/app/actions/customFields.ts");
const lib = src("src/lib/customFields.ts");

test("the lookups REQUIRE a workspace — an optional one was no filter at all", () => {
  assert.match(values, /opts: \{ tenantId: string; includeInactive\?: boolean \}/);
  assert.match(values, /export async function getFieldsWithValues\(\s*entity: CustomEntity,\s*recordId: string,\s*tenantId: string,/);
  assert.match(values, /export async function customRuleValues\(\s*entity: CustomEntity,\s*recordId: string,\s*tenantId: string,/);
  assert.match(values, /export async function linkTargetExists\(target: LinkTarget, id: string, tenantId: string\)/);
  assert.doesNotMatch(values, /tenantId \? \{ tenantId \} : \{\}|opts\.tenantId \?/, "no conditional workspace filter left");
});

test("1. a link field's target must be in the acting workspace", () => {
  assert.match(actions, /const tenantId = await actingTenantId\(\);\s*await requireEntityEdit\(entity, recordId, tenantId\);\s*const defs = await getFieldDefs\(entity, \{ tenantId \}\);/);
  assert.match(actions, /linkTargetExists\(def\.linkTo, parsed\.value, tenantId\)/);
  // Values are written stamped with the workspace.
  assert.match(actions, /create: \{ tenantId, defId: m\.defId, recordId, value: m\.value \}/);
  assert.match(actions, /deleteMany\(\{ where: \{ defId: m\.defId, recordId, tenantId \} \}\)/);
});

test("2. stage rules read the LEAD's workspace's fields", () => {
  const facts = src("src/lib/stageGateFacts.ts");
  assert.match(facts, /tenantId: true,/);
  assert.match(facts, /lead\.tenantId \? customRuleValues\("lead", leadId, lead\.tenantId\) : Promise\.resolve\(\{\}\)/);
});

test("3. product and stock edits check the row's workspace; the picker lists only this workspace's records", () => {
  assert.match(actions, /prisma\.product\.count\(\{ where: \{ id: recordId, tenantId, deletedAt: null \} \}\)/);
  assert.match(actions, /prisma\.stockUnit\.count\(\{ where: \{ id: recordId, tenantId, deletedAt: null \} \}\)/);
  assert.match(lib, /export async function loadLinkChoices\(fields: FieldWithValue\[\], tenantId: string\)/);
  assert.match(lib, /prisma\.product\.findMany\(\{\s*where: \{ tenantId, deletedAt: null \}/);
  assert.match(lib, /prisma\.contact\.findMany\(\{\s*where: \{ id: \{ in: linked\("contact"\) \}, tenantId, deletedAt: null/);
  for (const model of ["lead", "vehicle"]) {
    assert.match(lib, new RegExp(`prisma\\.${model}\\.findMany\\(\\{\\s*where: \\{ tenantId, deletedAt: null`), `${model} choices name the workspace`);
    assert.match(lib, new RegExp(`prisma\\.${model}\\.findMany\\(\\{ where: \\{ id: \\{ in: missing \\}, tenantId, deletedAt: null`), `already-linked ${model}s too`);
  }
});

test("field definitions: created, updated and deleted only in the acting workspace; keys unique per workspace", () => {
  assert.match(actions, /prisma\.customFieldDef\.updateMany\(\{\s*where: \{ id, tenantId \},/);
  assert.match(actions, /data: \{\s*tenantId,\s*entity,/);
  assert.match(actions, /prisma\.customFieldDef\.findFirst\(\{ where: \{ id, tenantId \} \}\)/);
  assert.match(actions, /prisma\.customFieldDef\.deleteMany\(\{ where: \{ id, tenantId \} \}\)/);
  assert.match(src("prisma/schema.prisma"), /@@unique\(\[tenantId, entity, key\]\)/);
  const migration = src("prisma/migrations/20261112010000_custom_field_key_per_workspace/migration.sql");
  assert.ok(migration.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS") < migration.indexOf("DROP INDEX IF EXISTS"), "the new index exists before the old one goes");
  // Legacy rows with no workspace are stamped BEFORE the per-workspace key rule applies, so none vanishes.
  const backfill = src("prisma/migrations/20261112005000_custom_field_legacy_workspace/migration.sql");
  assert.match(backfill, /UPDATE "CustomFieldDef" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;/);
  assert.match(backfill, /SET "tenantId" = d\."tenantId"\s*FROM "CustomFieldDef" d\s*WHERE v\."defId" = d\.id\s*AND v\."tenantId" IS NULL/);
  assert.ok("20261112005000_custom_field_legacy_workspace" < "20261112010000_custom_field_key_per_workspace", "backfill runs first");
  // The real-database test runs in CI.
  assert.match(src(".github/workflows/security-rbac-ci.yml"), /run: npm run test:custom-fields-workspaces/);
});
