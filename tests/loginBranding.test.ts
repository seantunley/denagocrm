import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { UNBRANDED, toLoginBrand } from "../src/lib/loginBrand";
import { DEFAULT_BRAND, brandFromRow } from "../src/lib/tenantBrand";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const STAFF = "src/app/login/LoginClient.tsx";
const PORTAL = "src/app/portal/login/PortalLoginClient.tsx";

/**
 * The login pages are the only surfaces that cannot name their tenant from
 * anything they hold — no session, no contact, no token — so they resolve it
 * from the hostname. They are also the pages where a mistake costs the most: a
 * sign-in page that fails is a lockout of the entire workspace, for a feature
 * whose entire output is an accent colour and a logo.
 *
 * Everything here defends one of two properties:
 *   A. Unbranded output is byte-for-byte what shipped before.
 *   B. Nothing on this path can throw.
 */

/* ── A. unbranded is unchanged ───────────────────────────────────────────── */

test("a request that resolves to no tenant is not branded", () => {
  assert.equal(toLoginBrand(DEFAULT_BRAND).branded, false);
  assert.deepEqual(toLoginBrand(DEFAULT_BRAND), UNBRANDED);
  assert.equal(UNBRANDED.style, null, "no accent override");
  assert.equal(UNBRANDED.logoUrl, null, "the built-in asset is used");
});

test("`branded` keys off the tenant id, not off the display name", () => {
  // Keying off displayName would call the DEFAULT brand "branded" — it has one —
  // and every substitution below would switch on for a request that resolved to
  // nobody.
  const resolved = brandFromRow({
    tenantId: "t1",
    brandPrimary: null,
    brandLogoRef: null,
    brandDisplayName: null, // falls back to the default NAME…
    brandTagline: null,
  });
  assert.equal(resolved.displayName, DEFAULT_BRAND.displayName);
  assert.equal(toLoginBrand(resolved).branded, true, "…but a real tenant resolved, so it IS branded");
  assert.equal(toLoginBrand({ ...resolved, tenantId: null }).branded, false);
});

test("every brand substitution keeps the original literal on the unbranded path", () => {
  // The property that makes "nothing changes when this merges" checkable rather
  // than hopeful: each ternary's FALSE branch is the string that was there
  // before, not a value derived from UNBRANDED that happens to match today.
  const expected: Array<[string, string]> = [
    [STAFF, '"Sign in to keep Cape Town moving."'],
    [STAFF, '"Denago Cape Town"'],
    [STAFF, '"Cape Town hub"'],
    [STAFF, '"The command centre for Denago sales, service and lasting customer relationships."'],
    [STAFF, '"you@denagocpt.co.za"'],
    [PORTAL, '"Your Denago"'],
    [PORTAL, '"Use the address you shared with Denago Cape Town."'],
    [PORTAL, '"Denago Cape Town"'],
    [PORTAL, '"My Denago"'],
    [PORTAL, '"Your personal window into service, documents and support from Denago Cape Town."'],
  ];
  for (const [file, literal] of expected) {
    const code = shipped(file);
    assert.ok(
      code.includes(`: ${literal}`),
      `${file}: the unbranded branch must still be the original literal ${literal}`,
    );
  }
});

test("every brand-dependent string is gated on `branded`, never rendered raw", () => {
  // A `{brand.displayName}` rendered as TEXT with no gate would put the DEFAULT
  // name where a literal used to be — indistinguishable today, and wrong the
  // moment the default becomes a neutral shell.
  //
  // The lookbehind excludes two forms that are NOT bare renders:
  //   `=` — an ATTRIBUTE value (`alt={brand.displayName}`). Those sit inside the
  //         `brand.logoUrl ? …` branch, and a logo URL cannot exist without a
  //         resolved tenant, so they are gated by construction — and the
  //         tenant's name is the correct alt text there.
  //   `$` — template-literal interpolation (`` `Sign in to ${brand.displayName}` ``),
  //         which is the CONSEQUENT of a `brand.branded ?` ternary and therefore
  //         already gated. Matching it would flag every correct substitution.
  for (const file of [STAFF, PORTAL]) {
    const code = shipped(file);
    for (const match of code.matchAll(/(?<![=$])\{brand\.(displayName|tagline)\}/g)) {
      assert.fail(`${file}: \`${match[0]}\` is rendered as text without a brand.branded gate`);
    }
  }
  // …and the gate really is what makes the attribute case safe.
  for (const file of [STAFF, PORTAL]) {
    for (const match of shipped(file).matchAll(/=\{brand\.displayName\}/g)) {
      void match;
      assert.match(
        shipped(file),
        /brand\.logoUrl \? \(/,
        `${file}: an attribute may use brand.displayName only inside the logoUrl branch`,
      );
    }
  }
});

test("the built-in logo is still rendered when no tenant logo is set", () => {
  for (const [file, asset] of [
    [STAFF, "/branding/denago-cape-town-logo.png"],
    [STAFF, "/branding/denago-mark.png"],
    [PORTAL, "/branding/denago-cape-town-logo.png"],
    [PORTAL, "/branding/denago-mark.png"],
  ] as const) {
    const code = shipped(file);
    assert.ok(code.includes(asset), `${file}: the ${asset} fallback must survive`);
    assert.match(
      code,
      /brand\.logoUrl \? \(/,
      `${file}: the tenant logo must be a conditional over that fallback, not a replacement`,
    );
  }
});

/* ── B. nothing on this path can throw ───────────────────────────────────── */

test("the login brand resolver swallows everything", () => {
  const code = shipped("src/lib/loginBrand.tsx");
  const start = code.indexOf("export async function loginBrand");
  assert.notEqual(start, -1, "loginBrand is gone — was it renamed?");
  const body = code.slice(start, code.indexOf("export function BrandStyle", start));
  assert.match(body, /try \{/);
  assert.match(body, /\} catch \{\s*return UNBRANDED;/, "every failure renders the page unbranded");
  // headers() must be INSIDE the try — a request-scope problem must not escape
  // either, and it is the one call here that is not already total.
  const tryAt = body.indexOf("try {");
  const headersAt = body.indexOf("headers()");
  assert.ok(tryAt !== -1 && headersAt > tryAt, "headers() must be read inside the try block");
});

test("the server pages do nothing but resolve the brand and render", () => {
  // Every line added to a login page is a line that can break sign-in. These two
  // wrappers exist to call one total function and pass a prop.
  for (const file of ["src/app/login/page.tsx", "src/app/portal/login/page.tsx"]) {
    const code = shipped(file);
    assert.match(code, /await loginBrand\(\)/, `${file} must resolve the brand`);
    assert.doesNotMatch(code, /prisma|basePrisma/, `${file} must not query anything itself`);
    assert.doesNotMatch(code, /throw |redirect\(|notFound\(/, `${file} must have no failure path`);
  }
});

test("the accent override emits no element at all when there is no accent", () => {
  // Not an empty <style>: no element. That is what keeps unbranded markup
  // byte-identical to what shipped before.
  const code = shipped("src/lib/loginBrand.tsx");
  assert.match(code, /if \(!brand\.style\) return null;/);
});

test("the interactive halves are unchanged client components", () => {
  // The split must move the client code, not rewrite it. If these stopped being
  // client components the hooks they rely on would fail at build time — but the
  // build would fail loudly, whereas a lost "use client" plus a silently dropped
  // hook is the shape that reaches production.
  for (const file of [STAFF, PORTAL]) {
    assert.match(read(file).slice(0, 20), /^"use client";/, `${file} must stay a client component`);
  }
  for (const [file, hook] of [
    [STAFF, "useActionState"],
    [STAFF, "useSearchParams"],
    [STAFF, "useSyncExternalStore"],
    [PORTAL, "useActionState"],
  ] as const) {
    assert.ok(shipped(file).includes(hook), `${file}: ${hook} must survive the split`);
  }
});
