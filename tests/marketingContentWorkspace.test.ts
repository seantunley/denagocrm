import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

const audiencePage = read("src", "app", "(app)", "marketing", "audiences", "page.tsx");
const audienceWorkspace = read("src", "components", "marketing", "AudienceWorkspace.tsx");
const audienceEngine = read("src", "lib", "marketingAudiences.ts");
const marketingActions = read("src", "app", "actions", "marketingContent.ts");
const templatePage = read("src", "app", "(app)", "marketing", "templates", "page.tsx");
const templateWorkspace = read("src", "components", "marketing", "TemplateWorkspace.tsx");
const confirmationDialog = read("src", "components", "marketing", "ConfirmActionDialog.tsx");

test("marketing audience workspace replaces raw JSON editing with the visual builder", () => {
  assert.match(audiencePage, /<AudienceWorkspace/);
  assert.doesNotMatch(audiencePage, /<textarea[^>]+name="ruleTree"/);
  assert.match(audienceWorkspace, /MatchToggle/);
  assert.match(audienceWorkspace, /Add condition/);
  assert.match(audienceWorkspace, /Add exclusion/);
  assert.match(audienceWorkspace, /Preview audience/);
  assert.match(audienceWorkspace, /Marketing consent enforced/);
});

test("audience page lookups remain explicitly scoped to the active tenant", () => {
  assert.match(audiencePage, /WHERE s\."tenantId" IS NOT DISTINCT FROM \$\{tenantId\}/);
  assert.match(audiencePage, /where: \{ tenantId \}/);
  assert.match(audiencePage, /where: \{ tenantId, active: true, deletedAt: null \}/);
  assert.match(audiencePage, /v\."tenantId" IS NOT DISTINCT FROM \$\{tenantId\}/);
});

test("audience rule ids are revalidated server-side by tenant", () => {
  assert.match(audienceEngine, /validateAudienceReferences/);
  assert.match(audienceEngine, /basePrisma\.tag\.count\(\{ where: \{ tenantId, id: \{ in: tagIds \} \} \}\)/);
  assert.match(audienceEngine, /basePrisma\.product\.count\(\{ where: \{ tenantId, id: \{ in: productIds \} \} \}\)/);
  assert.match(audienceEngine, /tag that does not belong to this tenant/);
  assert.match(audienceEngine, /product that does not belong to this tenant/);
  assert.match(marketingActions, /await validateAudienceReferences\(tree, tenantId\)/);
});

test("audience evaluation scopes root and related records to the active tenant", () => {
  assert.match(audienceEngine, /where: \{ tenantId, deletedAt: null, marketingOptOut: false \}/);
  assert.match(audienceEngine, /tags: \{ where: \{ tenantId: tenantId \?\? "__no_tenant__" \} \}/);
  assert.match(audienceEngine, /vehicles: \{[\s\S]*?where: \{ tenantId, deletedAt: null \}/);
  assert.match(audienceEngine, /serviceRecords: \{ where: \{ tenantId \} \}/);
  assert.match(audienceEngine, /mileageLogs: \{ where: \{ tenantId \} \}/);
  assert.match(audienceEngine, /leads: \{ where: \{ tenantId, deletedAt: null \} \}/);
  assert.match(audienceEngine, /quotes: \{ where: \{ tenantId, deletedAt: null \} \}/);
  assert.match(audienceEngine, /await validateAudienceReferences\(tree, tenantId\)/);
});

test("audience and template destructive actions use product dialogs, not native browser confirms", () => {
  assert.match(audienceWorkspace, /ConfirmActionDialog/);
  assert.match(templateWorkspace, /ConfirmActionDialog/);
  assert.match(confirmationDialog, /ResponsiveDialogContent/);
  assert.doesNotMatch(audienceWorkspace, /window\.confirm|\bconfirm\s*\(/);
  assert.doesNotMatch(templateWorkspace, /window\.confirm|\bconfirm\s*\(/);
});

test("template workspace is tenant-scoped and uses a structured draft/publish UX", () => {
  assert.match(templatePage, /WHERE "tenantId" IS NOT DISTINCT FROM \$\{tenantId\}/);
  assert.match(templatePage, /<TemplateWorkspace/);
  assert.doesNotMatch(templatePage, /<textarea[^>]+name="body"/);
  assert.match(templateWorkspace, /Template library/);
  assert.match(templateWorkspace, /Use as new draft/);
  assert.match(templateWorkspace, /Published content is immutable/);
  assert.match(templateWorkspace, /sandbox=""/);
});

test("template category choices and server validation use the same governed vocabulary", () => {
  for (const category of [
    "marketing_email",
    "marketing_sms",
    "transactional_email",
    "transactional_sms",
    "service_reminder",
    "survey_invite_email",
    "survey_invite_sms",
    "internal_notification",
  ]) {
    assert.match(templateWorkspace, new RegExp(`value: "${category}"`));
    assert.match(marketingActions, new RegExp(`"${category}"`));
  }
});

test("template writes reject another tenant's globally addressed template id", () => {
  assert.match(marketingActions, /SELECT "tenantId" FROM "EmailTemplate" WHERE "id" = \$\{input\.id\} FOR UPDATE/);
  assert.match(marketingActions, /allRows\[0\]\.tenantId !== tenantId/);
  assert.match(marketingActions, /Template belongs to another tenant/);
  assert.match(marketingActions, /AND "tenantId" IS NOT DISTINCT FROM \$\{tenantId\}/);
});
