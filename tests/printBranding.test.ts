import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { DEFAULT_SIGNATURE_COMPANY, buildSignature } from "../src/lib/signature";
import { PLATFORM_NAME } from "../src/lib/platformIdentity";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const PRINT_PAGES = [
  "src/app/(print)/jobcards/[id]/service-report/page.tsx",
  "src/app/(print)/leads/[id]/indemnity/page.tsx",
  "src/app/(print)/quotes/[id]/agreement/page.tsx",
  "src/app/(print)/quotes/[id]/delivery-note/page.tsx",
  "src/app/(print)/quotes/[id]/invoice/page.tsx",
  "src/app/(print)/warranty/[id]/print/page.tsx",
];

/**
 * Phase 5 of BRANDING-ROADMAP.md — print, PDFs and the email signature.
 *
 * These differ in kind from every phase before: a DOCUMENT's brand is the
 * company it is FROM, which is a property of the workspace that issued it, not
 * of whoever happens to be looking at it.
 *
 * The Company Profile already expressed that, per-tenant, and customDocs.ts
 * already used it as its single source. The gap was the surfaces that hardcoded
 * Denago INSTEAD of reading it — and the fact that a platform admin could brand
 * a tenant's app while every document they printed still carried the Denago
 * mark, because nothing joined Tenant.brand* to the Company Profile.
 */

test("the company profile resolves in one order: own, then platform, then default", () => {
  // The fix for there being two logos. Before this a tenant would have had to
  // upload the same asset twice — once by their admin into the profile, once by
  // a platform admin into the tenant brand — and the two could drift.
  const code = shipped("src/lib/companyProfile.ts");
  assert.match(code, /brandForTenant\(await getActiveTenantId\(\)/, "step 2 is the platform-set brand");
  assert.match(
    code,
    /own \|\| fromBrand\[field\] \|\| COMPANY_DEFAULTS\[field\]/,
    "own profile → tenant brand → built-in default, in that order",
  );
  assert.match(code, /\.catch\(\(\) => null\)/, "a brand lookup failure must not break a document");
});

test("own-profile-first, because only it can express an address", () => {
  const code = shipped("src/lib/companyProfile.ts");
  const start = code.indexOf("const fromBrand");
  const block = code.slice(start, code.indexOf("return Object.fromEntries", start));
  // The tenant brand supplies exactly three fields. It has no address, phone,
  // email or socials to supply, so those can only come from the profile.
  for (const field of ["name:", "tagline:", "logoUrl:"]) {
    assert.ok(block.includes(field), `the tenant brand should contribute ${field}`);
  }
  for (const absent of ["address:", "phone:", "email:", "facebook:"]) {
    assert.ok(!block.includes(absent), `the tenant brand has no ${absent} to contribute`);
  }
});

test("a document logo URL from the tenant brand is absolute", () => {
  // It is embedded in printed HTML and in emailed signatures, neither of which
  // has an origin to resolve a path against.
  const code = shipped("src/lib/companyProfile.ts");
  assert.match(code, /\$\{await tenantOrigin\(tenantBrand\.tenantId\)\}\$\{brandLogoUrl\(tenantBrand\)\}/);
});

test("every print page passes the company it is from", () => {
  for (const page of PRINT_PAGES) {
    const code = shipped(page);
    assert.match(code, /const company = await getCompanyProfile\(\);/, `${page} must resolve it`);
    assert.match(code, /company=\{company\}/, `${page} must pass it to the shell`);
  }
});

test("the print shell names no customer when no company is given", () => {
  // This pinned three Denago literals, for the reason every phase of the brand
  // work pinned literals: `company` is optional, so an un-updated caller had to
  // render byte-for-byte what it rendered before.
  //
  // Every print page passes a company (asserted above), so those fallbacks are
  // unreachable in practice — which is exactly the argument that left Denago's
  // name in the platform defaults for as long as it was there. They are the
  // platform's name now.
  const code = shipped("src/components/print/PrintDocShell.tsx");
  assert.match(code, /company\?: \{ name: string; tagline: string; logoUrl: string \}/, "still optional");
  assert.match(code, /\|\| "\/branding\/denago-logo-email\.png"/, "logo fallback");
  assert.match(code, /company\?\.name \|\| PLATFORM_NAME/, "alt text and counter-signature");
  assert.match(code, /\[company\?\.name \|\| PLATFORM_NAME, company\?\.tagline\]/, "footer");
  // The built-in logo FILE stays: swapping it needs a neutral replacement image,
  // not a code change. Tracked in appShellBranding.test.ts's STILL_HARDCODED.
  const withoutAsset = code.replace(/"\/branding\/[^"]*"/g, "");
  assert.doesNotMatch(withoutAsset, /Denago/, "no customer named in any fallback");
});

test("the template's own logo still wins over the company's", () => {
  // Document Studio templates carry their own uploaded logo. That is a
  // per-DOCUMENT choice and must outrank the workspace default, or setting it
  // would silently stop working.
  const code = shipped("src/components/print/PrintDocShell.tsx");
  assert.match(code, /src=\{tpl\.logoUrl \|\| company\?\.logoUrl \|\| "\/branding\/denago-logo-email\.png"\}/);
  // `||`, not `??`. An unset COMPANY_LOGO_URL resolves to the EMPTY STRING, not
  // null — `??` passed it through and rendered `<img src="">`, which browsers
  // resolve to the current page and draw as a broken image on a printed
  // document. Harmless while every workspace was configured; the normal case now.
  assert.doesNotMatch(code, /company\?\.logoUrl \?\?/, "?? does not skip an empty string");
});

test("the counter-signature label names the seller, resolved not defaulted", () => {
  // It moved out of the parameter default into the body, because a default
  // cannot see `company`. Leaving it as a default would have signed every
  // tenant's sales agreement "For Denago Cape Town".
  const code = shipped("src/components/print/PrintDocShell.tsx");
  assert.doesNotMatch(code, /parties = \{ left:/, "no longer a parameter default");
  assert.match(code, /const signingParties = parties \?\? \{/);
  assert.match(code, /For \$\{company\?\.name \|\| PLATFORM_NAME\} · Date/);
});

test("an omitted company names nobody, and still produces a valid signature", () => {
  // This test used to assert the opposite — that an omitted company produced
  // Denago's name, tagline, website and logo. That was right while the platform
  // had one customer and is a leak now: those defaults reached every workspace
  // that had not filled in Settings → Company, so their staff signed emails with
  // another company's website and landline. The details moved to Denago's own
  // Company Profile in 20260806190000_seed_founding_tenant_brand.
  const user = { name: "Sam Ndlovu", email: "sam@example.com", jobTitle: "Sales" };
  const html = buildSignature(user);
  assert.doesNotMatch(html, /Denago/, "no customer's identity in the platform default");
  assert.doesNotMatch(html, /denagocpt/);
  assert.equal(DEFAULT_SIGNATURE_COMPANY.name, PLATFORM_NAME);

  // Empty fields must remove their element, not empty it. `<img src="">`
  // re-requests the current page and renders broken; `href="https://"` is a dead
  // link; a footer of " — " is punctuation with nothing on either side.
  assert.doesNotMatch(html, /src=""/, "no empty image source");
  assert.doesNotMatch(html, /href="https:\/\/"/, "no dead website link");
  assert.doesNotMatch(html, /&nbsp;—&nbsp;|>\s*—\s*</, "no dangling footer separator");
  // What survives: the person. That is the part we actually know.
  assert.match(html, /Sam Ndlovu/);
  assert.match(html, /sam@example\.com/);
});

test("the company switchboard is the workspace's own, never a literal", () => {
  // "073 789 3438" was typed into the template, outside the `company` object —
  // so every tenant's staff published Denago's landline on every email they
  // sent, and invited their customers to phone it.
  const code = shipped("src/lib/signature.ts");
  assert.doesNotMatch(code, /073\s?789\s?3438|\+?27737893438/, "no hardcoded phone number");

  const withPhone = buildSignature(
    { name: "Sam", email: "s@e.com" },
    { ...DEFAULT_SIGNATURE_COMPANY, switchboard: "021 555 0100" },
  );
  assert.match(withPhone, /021 555 0100/);
  assert.match(withPhone, /href="tel:0215550100"/, "dialable, punctuation stripped");

  // …and no row at all when the workspace has not given one.
  const without = buildSignature({ name: "Sam", email: "s@e.com" }, DEFAULT_SIGNATURE_COMPANY);
  assert.doesNotMatch(without, /href="tel:"/, "an empty number renders no link");
});

test("a supplied company replaces every hardcoded part of the signature", () => {
  const html = buildSignature(
    { name: "Sam Ndlovu", email: "sam@example.com" },
    {
      name: "Acme Golf Carts",
      tagline: "Fleet sales & service",
      address: "1 Fairway Road, Somerset West",
      website: "acmegolf.co.za",
      switchboard: "021 555 0100",
      assetBase: "https://acme-crm.co.za",
      logoUrl: "https://cdn.example.com/acme.png",
      facebook: "https://facebook.com/acmegolf",
      instagram: "https://instagram.com/acmegolf",
    },
  );
  assert.match(html, /Acme Golf Carts/);
  assert.match(html, /acmegolf\.co\.za/);
  assert.match(html, /cdn\.example\.com\/acme\.png/);
  // No Denago IDENTITY may survive — name, tagline, website, address, logo.
  //
  // The Facebook and Instagram GLYPHS are excluded from this assertion on
  // purpose: they are third-party platform marks that we host, and their URL
  // follows NEXT_PUBLIC_APP_URL. On a per-tenant domain they are still fetched
  // from the platform's host — a known white-label gap, documented at SITE in
  // signature.ts, that needs per-tenant asset hosting rather than a URL change.
  const withoutGlyphs = html.replace(/<img src="[^"]*\/branding\/social-[^"]*"[^>]*>/g, "");
  assert.doesNotMatch(withoutGlyphs, /Denago/);
  assert.doesNotMatch(withoutGlyphs, /Maitland/);
});

test("the signature is escaped, because a company name is user input", () => {
  const html = buildSignature(
    { name: "Sam", email: "s@e.com" },
    { ...DEFAULT_SIGNATURE_COMPANY, name: `Acme<script>alert(1)</script>` },
  );
  assert.doesNotMatch(html, /<script>/, "a workspace name reaches an HTML email body");
  assert.match(html, /&lt;script&gt;/);
});

test("the settings preview renders what the send path renders", () => {
  // The one screen where you check your signature must not be the one screen
  // that lies about it.
  const settings = shipped("src/app/(app)/settings/page.tsx");
  const action = shipped("src/app/actions/emails.ts");
  for (const [file, code] of [["settings", settings], ["emails action", action]] as const) {
    assert.match(code, /getCompanyProfile\(\)/, `${file} must resolve the profile`);
    assert.match(code, /signatureCompanyFrom\(profile, await tenantOrigin\(/, `${file} must map it through the ONE helper, on the tenant origin`);
  }
  assert.match(settings, /buildSignature\(currentUser, signatureCompany\)/);
});
