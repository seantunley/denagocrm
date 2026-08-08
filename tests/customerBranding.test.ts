import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * Phase 3 of BRANDING-ROADMAP.md — the surfaces a tenant's CUSTOMERS see.
 *
 * The roadmap called these "arguably higher value than internal chrome", and for
 * white-label they are the whole point: a customer greeted by another company's
 * name has been handed a reason to doubt where they just typed their email
 * address, or whose contract they are about to sign.
 *
 * THREE different tenant resolutions, because these surfaces genuinely differ:
 *
 *   portal   → the signed-in CONTACT's tenant, hostname as fallback (its layout
 *              wraps both the authenticated pages and its own login)
 *   signing  → the tenant the TOKEN already established (withTokenTenantScope);
 *              a signing link is mailed to an outside party and may well be
 *              opened on the platform's domain
 *   survey   → hostname only, because a layout does not receive page params
 */

const PORTAL_PAGES = [
  "src/app/portal/documents/page.tsx",
  "src/app/portal/page.tsx",
  "src/app/portal/profile/page.tsx",
  "src/app/portal/support/page.tsx",
  "src/app/portal/support/[id]/page.tsx",
];

test("customerBrand prefers the customer's own tenant over the hostname", () => {
  // Order matters and is not merely convenient: a customer who followed an
  // emailed link to the platform's default domain should still see the brand of
  // the company they actually deal with.
  const code = shipped("src/lib/loginBrand.tsx");
  const start = code.indexOf("export async function customerBrand");
  assert.notEqual(start, -1, "customerBrand is gone — was it renamed?");
  const body = code.slice(start, code.indexOf("export function BrandStyle", start));
  const contactAt = body.indexOf("brandForTenant");
  const hostAt = body.indexOf("brandForHost");
  assert.ok(contactAt !== -1 && hostAt !== -1, "both resolutions must exist");
  assert.ok(contactAt < hostAt, "the contact's tenant must be tried FIRST");
  assert.match(body, /\} catch \{\s*return UNBRANDED;/, "a customer-facing page must not fail over decoration");
});

test("the portal layout resolves contact-first and cannot throw", () => {
  const code = shipped("src/app/portal/layout.tsx");
  assert.match(code, /getPortalContact\(\)\.catch\(\(\) => null\)/, "a portal-session failure must not break the shell");
  assert.match(code, /customerBrand\(contact\?\.tenantId \?\? null\)/);
  assert.match(code, /<BrandStyle brand=\{brand\} \/>/, "the accent applies to the whole portal");
  assert.match(code, /<BrandLogo/, "…and the header logo goes through the shared component");
});

test("the signing page brands from the token's tenant, not the hostname", () => {
  // withTokenTenantScope has already derived and entered the tenant by the time
  // the page renders, so the scope is the honest source. Using the hostname here
  // would brand a mailed link by wherever it happened to be opened.
  const code = shipped("src/app/signing/[token]/page.tsx");
  assert.match(code, /customerBrand\(currentTenantScope\(\)\?\.tenantId \?\? null\)/);
  assert.match(code, /withTokenTenantScope\(/, "the scope this reads must still be established first");
  const scopeAt = code.indexOf("withTokenTenantScope(");
  const brandAt = code.indexOf("customerBrand(currentTenantScope()");
  assert.ok(scopeAt < brandAt, "the scope must be entered before the brand is read from it");
});

test("the survey layout is honest about resolving by hostname only", () => {
  const code = shipped("src/app/s/layout.tsx");
  assert.match(code, /customerBrand\(null\)/, "null → falls through to the hostname");
  assert.match(code, /<BrandLogo/);
});

test("every portal page resolves the brand through the shared cached helper", () => {
  // Not five independent lookups: getPortalContact, brandForTenant and
  // brandForHost are all cache()d, so the layout and every page in one render
  // share a single resolution.
  for (const page of PORTAL_PAGES) {
    const code = shipped(page);
    assert.match(code, /const brand = await portalBrand\(\);/, `${page} must resolve the brand`);
    assert.doesNotMatch(code, /brandForHost|brandForTenant/, `${page} must not resolve it itself`);
  }
  const helper = shipped("src/lib/portalBrand.ts");
  assert.match(helper, /getPortalContact\(\)\.catch\(\(\) => null\)/);
  assert.match(helper, /customerBrand\(/);
});

test("every customer-facing substitution keeps the original literal unbranded", () => {
  // Same property as the login pages, on the surfaces where being wrong is most
  // visible to somebody who is not your staff.
  const expected: Array<[string, string]> = [
    ["src/app/portal/documents/page.tsx", '"Files are attached directly to your customer record and are only visible to the Denago team."'],
    ["src/app/portal/documents/page.tsx", '"Documents from Denago"'],
    ["src/app/portal/page.tsx", '"Your Denago garage"'],
    ["src/app/portal/profile/page.tsx", '"Keep your details current and choose how Denago may contact you about service, support and offers."'],
    ["src/app/portal/support/page.tsx", '"Tell us what you need and we’ll route it to the right Denago specialist."'],
    ["src/app/portal/support/[id]/page.tsx", '"Messages between you and the Denago team."'],
    ["src/app/portal/support/[id]/page.tsx", '"Denago Cape Town"'],
    ["src/app/signing/[token]/page.tsx", '"This signing link is no longer active. Please contact Denago Cape Town."'],
    ["src/app/signing/[token]/page.tsx", '"This signing link has expired. Please ask Denago to resend it."'],
    ["src/app/signing/[token]/page.tsx", '"You declined to sign this document. Contact Denago if this was a mistake."'],
  ];
  for (const [file, literal] of expected) {
    assert.ok(
      shipped(file).includes(`: ${literal}`),
      `${file}: the unbranded branch must still be the original literal ${literal}`,
    );
  }
});

test("the signing shell keeps its wordmark when nothing resolved", () => {
  // Three states, and the middle one matters: a tenant with a NAME but no logo
  // must render their name, not the Denago wordmark and not nothing.
  const code = shipped("src/app/signing/[token]/page.tsx");
  assert.match(code, /brand\?\.logoUrl \? \(/, "a tenant logo wins");
  assert.match(code, /\) : brand\?\.branded \? \(/, "…then a tenant name");
  assert.match(code, /DENAGO <span style=\{\{ color: "#ea580c" \}\}>CAPE TOWN<\/span>/, "…then the original wordmark");
});

test("SignSurface's sender name defaults to the original literal", () => {
  // A CLIENT component, so it takes a prop rather than resolving anything. The
  // default is the literal that was hardcoded, so an unbranded render is unchanged.
  const code = shipped("src/app/signing/[token]/SignSurface.tsx");
  assert.match(code, /const sender = senderName \?\? "Denago";/);
  assert.match(code, /senderName\?: string/, "optional — an omitted prop is the old behaviour");
  const page = shipped("src/app/signing/[token]/page.tsx");
  assert.match(
    page,
    /senderName=\{brand\.branded \? brand\.displayName : undefined\}/,
    "…and the page passes undefined rather than the default name when unbranded",
  );
});
