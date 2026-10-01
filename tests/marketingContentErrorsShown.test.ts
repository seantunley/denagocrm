import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #22, marketing audiences + templates. The workspaces showed
// `caught.message`, but a message thrown from a Server Action is redacted in
// production — so "every group needs a rule", "email templates need a subject",
// "published templates can't be edited" all arrived as a generic failure. Five
// of these actions also bound no workspace at all.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const actions = src("src/app/actions/marketingContent.ts");

test("every mutation returns its refusal (and binds the workspace)", () => {
  for (const name of ["createMarketingAudience", "updateMarketingAudience", "archiveMarketingAudience", "saveMarketingTemplate", "publishMarketingTemplate", "archiveMarketingTemplate"]) {
    const at = actions.indexOf(`export async function ${name}(`);
    assert.ok(at >= 0, name);
    assert.match(actions.slice(at, at + 200), /return asActionResult\(async \(\) => \{/, name);
  }
  assert.doesNotMatch(actions, /throw new Error\(/);
});

test("the preview returns its refusal instead of throwing it", () => {
  assert.match(actions, /export async function previewMarketingAudience\(formData: FormData\): Promise<AudiencePreview \| \{ error: string \}>/);
  assert.match(actions, /if \(error instanceof ActionRefusal\) return \{ error: error\.message \};/);
});

test("the audience rule checks are refusals at the source", () => {
  const lib = src("src/lib/marketingAudiences.ts");
  assert.doesNotMatch(lib, /throw new Error\(/);
  assert.match(lib, /throw new ActionRefusal\("Every audience group needs at least one rule"\)/);
});

test("both workspaces read the returned refusal", () => {
  const audience = src("src/components/marketing/AudienceWorkspace.tsx");
  assert.match(audience, /if \("error" in result\) setError\(result\.error\);/);
  assert.equal((audience.match(/if \(result\?\.error\) throw new Error\(result\.error\);/g) ?? []).length, 2);
  const templates = src("src/components/marketing/TemplateWorkspace.tsx");
  assert.equal((templates.match(/if \(result\?\.error\) throw new Error\(result\.error\);/g) ?? []).length, 3);
});
