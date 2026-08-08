import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { brandLogoUrl, brandLogoAsset } from "../src/lib/tenantBrand";

const root = path.join(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

/**
 * "A signed document cannot rebrand" was not true of the logo.
 *
 * The URL carried `?v=<hash of the ref>`, which LOOKED versioned; the route
 * ignored it completely and served whatever Tenant.brandLogoRef said at request
 * time. Uploading a replacement also deleted the old object. So a contract
 * signed last year showed this year's logo — or failed to render one at all —
 * which is precisely the mutation freezing a brand exists to prevent.
 */

const brand = (logoRef: string | null) =>
  ({ tenantId: "t_acme", logoRef } as Parameters<typeof brandLogoUrl>[0]);

test("the frozen URL names a specific image, not 'whatever is current'", () => {
  const first = brandLogoUrl(brand("branding/t_acme/logo-1000.png"));
  const replacement = brandLogoUrl(brand("branding/t_acme/logo-2000.png"));

  assert.ok(first && replacement);
  assert.notEqual(first, replacement, "a different image must produce a different URL");
  // The asset itself, so the route can resolve it — not a cache-busting hash,
  // which is what made the old URL merely look versioned.
  assert.match(first, /\?a=logo-1000\.png$/);
  assert.doesNotMatch(first, /\?v=/);

  // Stable: freezing the same ref twice must produce the same URL, or a
  // re-render would appear to change the document.
  assert.equal(brandLogoUrl(brand("branding/t_acme/logo-1000.png")), first);
});

test("only a well-formed asset name is accepted", () => {
  // The route rebuilds the path from the tenant id and this value, so anything
  // that is not a plain logo filename must be refused outright.
  assert.equal(brandLogoAsset("branding/t_acme/logo-1000.png"), "logo-1000.png");
  assert.equal(brandLogoAsset("logo-42.webp"), "logo-42.webp");
  for (const bad of [
    "../../secrets.png",
    "logo-1000.png/../../other",
    "backups/db.png",
    "logo.png",
    "logo-.png",
    "logo-1000.exe",
    "",
    null,
  ]) {
    assert.equal(brandLogoAsset(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test("the route resolves the requested asset, and cannot leave the tenant's folder", () => {
  const route = read("src/app/api/brand/logo/[tenantId]/route.ts");
  assert.match(route, /searchParams\.get\("a"\)/);
  // The requested asset when one is named, the tenant's CURRENT logo otherwise —
  // so a frozen document keeps its logo and live surfaces follow a rebrand. Both
  // go through brandLogoAsset, which is what makes the filename trustworthy.
  assert.match(route, /brandLogoAsset\(requested \|\| tenant\.brandLogoRef\)/);
  // The path is REBUILT from the tenant id and that validated filename; nothing
  // from the request is concatenated into it. This used to be true only of the
  // requested branch — the stored ref was passed through — and unifying them is
  // what the logo-404 fix turned on: the column is now read for its NAME alone.
  assert.match(route, /const ref = `branding\/\$\{tenantId\}\/\$\{asset\}`/);
});

test("replacing a logo does not destroy the one a signed document points at", () => {
  const action = read("src/app/actions/tenantBranding.ts");
  // Deleting the previous object is what turned "the frozen URL serves the new
  // logo" into "the frozen URL serves nothing".
  const upload = action.slice(action.indexOf("putManagedBlob"), action.indexOf("brand_logo_changed"));
  assert.doesNotMatch(upload, /deleteFile\(previous\)/, "a replaced logo must be retained");
  assert.match(action, /RETAINED, not deleted/);
});

test("an uploaded SVG cannot execute against the CRM's own origin", () => {
  const route = read("src/app/api/brand/logo/[tenantId]/route.ts");
  // The comment claiming SVG is safe because it lives on another origin was
  // wrong: this route proxies it as image/svg+xml from the application's own
  // origin, so script inside it would run as the CRM.
  assert.match(route, /"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox"/);
  assert.match(route, /"X-Content-Type-Options": "nosniff"/);
});

test("removing a logo detaches it without destroying signed history", () => {
  const action = read("src/app/actions/tenantBranding.ts");
  const remove = action.slice(action.indexOf("no logo to remove"));
  // Fixing the replace path and not this one leaves the identical failure behind
  // a different button: a signed document whose frozen brand names the deleted
  // asset renders with a missing image, permanently.
  assert.doesNotMatch(remove, /deleteFile\(previous\)/, "removing must not destroy the asset");
  assert.match(remove, /brandLogoRef: null/, "…it still detaches the pointer");
  assert.match(action, /RETAIN the object/);
});
