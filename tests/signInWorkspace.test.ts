import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Sean, 2026-11-24: Fourbuy's logo "is not on the login screen". A workspace with no domain of its own gets
// /login?w=<slug> — honoured only where the address belongs to no workspace.
const code = (path: string) => readFileSync(path, "utf8");

test("a sign-in link names a workspace only on an address no workspace owns", () => {
  const brand = code("src/lib/loginBrand.tsx");
  assert.match(brand, /const named = !hostBrand\.tenantId && workspace \? await brandForSignInSlug\(workspace\) : null;/);
  assert.match(brand, /const brand = toLoginBrand\(named \?\? hostBrand\);/);
  // The tab title and icon follow the same rule.
  assert.match(brand, /if \(!workspace \|\| \(await brandForHost\(\(await headers\(\)\)\.get\("host"\)\)\)\.tenantId\) return \{\};/);
});

test("the slug is checked, the workspace must be active, and its own name stands in for a missing display name", () => {
  const lib = code("src/lib/signInWorkspace.ts");
  assert.match(lib, /const SLUG = \/\^\[a-z0-9\]\[a-z0-9-\]\{0,62\}\$\/;/);
  assert.match(lib, /where: \{ slug, active: true \}/);
  assert.match(lib, /brandDisplayName: brand\.brandDisplayName\?\.trim\(\) \|\| name/);
  assert.match(lib, /loginJson: true/);
});

test("the link a workspace is given is its own domain, else the PLATFORM's address — never another workspace's", () => {
  const lib = code("src/lib/signInWorkspace.ts");
  assert.match(lib, /domain \? `https:\/\/\$\{domain\.hostname\}\/login` : `\$\{PLATFORM_URL\}\/login\?\$\{SIGN_IN_WORKSPACE_PARAM\}=/);
  assert.doesNotMatch(lib, /appBaseUrl|tenantOrigin/);
  assert.match(code("src/app/(app)/settings/company/page.tsx"), /Your team&apos;s sign-in link:/);
  assert.match(code("src/app/platform/(console)/tenants/[id]/page.tsx"), /const signInLink = await signInLinkFor\(tenant\);/);
});
