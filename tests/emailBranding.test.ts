import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// emailBrand.ts is `server-only` — Next vendors that marker through an RSC
// export condition, so the unit runner cannot resolve it. Its behaviour is
// asserted on source below, the same way this suite treats portalBrand.ts.
import { DEFAULT_BRAND, teamSignoff } from "../src/lib/tenantBrand";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * Phase 4 of BRANDING-ROADMAP.md — email.
 *
 * Half of it was already done and is NOT rebuilt here: getSmtpConfig resolves
 * SMTP_FROM through resolveIntegrationBundle for the current tenant scope, so a
 * tenant that has configured its own SMTP already sends as itself. What was
 * still Denago's is the picture and the footer.
 *
 * The roadmap's constraint drives the rest: *"Email cannot use CSS variables.
 * Most mail clients ignore custom properties, so email templates need inline
 * styles and an absolute logo URL."*
 */

test("the sender identity is already per-tenant — this phase does not touch it", () => {
  const code = shipped("src/lib/email.ts");
  assert.match(code, /resolveIntegrationBundle\(tenantId, "smtp"\)/, "SMTP resolves per tenant already");
  assert.match(code, /currentTenantScope\(\)\?\.tenantId/, "…from the scope the send is inside");
});

test("an email logo URL is absolute, because a mail client has no origin", () => {
  const code = shipped("src/lib/emailBrand.ts");
  assert.match(code, /\$\{appBaseUrl\(\)\}\$\{relative\}/, "the app's base URL is prefixed");
  const shell = shipped("src/lib/campaigns.ts");
  assert.match(
    shell,
    /const logo = brand\?\.logoUrl \?\? `\$\{base\}\/branding\/denago-cape-town-logo\.png`;/,
    "…and the built-in fallback is absolute too",
  );
});

test("an unbranded send is byte-for-byte the old email", () => {
  const shell = shipped("src/lib/campaigns.ts");
  assert.match(shell, /: "Denago Cape Town";/, "the name falls back to the original literal");
  assert.match(
    shell,
    /: "Denago Cape Town &middot; Cape Town, South Africa";/,
    "…and so does the whole footer line",
  );
  // emailBrand.ts is `server-only` (Next vendors that marker via an RSC export
  // condition, so the unit runner cannot load it) — asserted on source, like the
  // other server-only modules in this suite.
  const brandModule = shipped("src/lib/emailBrand.ts");
  assert.match(brandModule, /branded: false,/);
  assert.match(brandModule, /displayName: DEFAULT_BRAND.displayName,/);
  assert.match(brandModule, /logoUrl: null,/);
});

test("a branded footer drops the address rather than inventing one", () => {
  // A tenant supplies a NAME, not a postal address. Printing the platform's
  // address under someone else's brand is a compliance problem in a marketing
  // footer, so the location half is dropped when branded.
  const shell = shipped("src/lib/campaigns.ts");
  const start = shell.indexOf("const footer =");
  const line = shell.slice(start, shell.indexOf("\n", start));
  assert.match(line, /brand\?\.branded \? name :/, "branded → the name alone");
  assert.doesNotMatch(line, /brand\.\w+ \+ ".*South Africa/, "never the tenant name plus our address");
});

test("emailBrand cannot fail a campaign send", () => {
  // Unlike a page there is no error boundary and no retry the recipient can
  // trigger — a throw here loses a marketing run to decoration.
  const code = shipped("src/lib/emailBrand.ts");
  assert.match(code, /\} catch \{\s*return UNBRANDED_EMAIL;/);
  assert.match(code, /if \(!tenantId\) return UNBRANDED_EMAIL;/);
});

test("both send paths pass a brand, resolved at the right granularity", () => {
  // The batch path resolves ONCE for up to 80 sends; the queue path handles one
  // recipient at a time and resolves from its tenant. brandForTenant is cache()d
  // either way, but the intent should be visible at the call site.
  const batch = shipped("src/lib/campaigns.ts");
  assert.match(batch, /const brand = await emailBrand\(tenantId\);/, "resolved once per batch");
  assert.match(batch, /buildTrackedEmail\(personalized, r\.token, brand\)/);
  const queue = shipped("src/lib/marketingCampaignQueue.ts");
  assert.match(queue, /await emailBrand\(recipient\.tenantId\)/, "per recipient's own tenant");
});

test("the brand parameter is optional, so an un-updated caller is unchanged", () => {
  const code = shipped("src/lib/campaigns.ts");
  assert.match(code, /function emailShell\(inner: string, unsubUrl: string, brand\?: EmailBrand\)/);
  assert.match(code, /export function buildTrackedEmail\(personalizedHtml: string, token: string, brand\?: EmailBrand\)/);
});

test("the team sign-off keeps the literal, not the resolved default", () => {
  // The distinction that survives DEFAULT_BRAND later becoming a neutral shell:
  // `The ${DEFAULT_BRAND.displayName} team` reads identically today and would
  // silently change then.
  assert.equal(teamSignoff(DEFAULT_BRAND), "The Denago Cape Town team");
  assert.equal(
    teamSignoff({ ...DEFAULT_BRAND, tenantId: "t1", displayName: "Acme Golf Carts" }),
    "The Acme Golf Carts team",
  );
  const code = shipped("src/lib/tenantBrand.ts");
  const start = code.indexOf("export function teamSignoff");
  // To the end of the FUNCTION, not the first `}` — which is the closing brace of
  // the `${brand.displayName}` interpolation, before the literal being asserted.
  const body = code.slice(start, code.indexOf("\n}", start));
  assert.match(body, /: "The Denago Cape Town team"/, "the literal, not DEFAULT_BRAND.displayName");
});

test("the vars helpers stay synchronous, with the sign-off as a defaulted parameter", () => {
  // Making them async to resolve a brand would ripple through both call sites and
  // every future one, for a sign-off line. An omitted argument is the old output.
  const code = shipped("src/lib/email.ts");
  assert.match(code, /export const DEFAULT_TEAM_SIGNOFF = "The Denago Cape Town team";/);
  assert.match(code, /teamName: string = DEFAULT_TEAM_SIGNOFF/, "defaulted parameter, not a lookup");
  assert.doesNotMatch(code, /export async function leadVars|export async function contactVars/);
  for (const page of ["src/app/(app)/contacts/[id]/page.tsx", "src/app/(app)/leads/[id]/page.tsx"]) {
    assert.match(shipped(page), /teamSignoff\(await brandForTenant\(/, `${page} must pass the resolved sign-off`);
  }
});
