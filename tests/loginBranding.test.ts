import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { UNBRANDED, toLoginBrand } from "../src/lib/loginBrand";
import { DEFAULT_BRAND, brandFromRow } from "../src/lib/tenantBrand";
import { PLATFORM_NAME } from "../src/lib/platformIdentity";

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

test("no login page names a customer, on either path", () => {
  // This test used to assert the OPPOSITE, and was right to: while the brand
  // system was landing, the unbranded branch had to be the exact string that was
  // there before, so that "nothing changes when this merges" was checkable
  // rather than hopeful. Ten literals were pinned that way.
  //
  // That scaffolding has done its job. Every one of those literals named Denago
  // or Cape Town, and a login page is served to whoever resolves the hostname —
  // so an unrecognised host greeted a stranger with one customer's trading name,
  // their city, and an email placeholder at their domain. The seed migration
  // makes Denago a branded tenant, so those strings now come from its own row and
  // the ternaries collapse to a single path.
  //
  // What replaces the pin: nothing in either file may name anyone. That is a
  // stronger property, and it does not need updating when the copy changes.
  const IDENTITY = /Denago|denagocpt|Cape Town hub|keep Cape Town moving/;
  for (const file of [STAFF, PORTAL]) {
    const code = shipped(file);
    // The built-in logo ASSET is exempt: it is a real file called
    // denago-cape-town-logo.png with matching alt text, and swapping it needs a
    // neutral replacement image rather than a code change. Tracked in
    // appShellBranding.test.ts's STILL_HARDCODED.
    const withoutAsset = code
      .replace(/src="\/branding\/[^"]*"/g, "")
      .replace(/alt="Denago Cape Town"/g, "");
    const hits = [...withoutAsset.matchAll(new RegExp(IDENTITY, "g"))];
    assert.deepEqual(
      hits.map((h) => h[0]),
      [],
      `${file}: a login page must not name a tenant — these are shown to whoever resolves the hostname`,
    );
  }
});

test("the unbranded name is the platform's, and it is one line", () => {
  // UNBRANDED derives from DEFAULT_BRAND rather than repeating a literal, so
  // there is exactly one place the fallback name is decided.
  assert.equal(UNBRANDED.displayName, PLATFORM_NAME);
  assert.equal(UNBRANDED.branded, false);
  assert.equal(UNBRANDED.tagline, null);
  assert.equal(UNBRANDED.logoUrl, null);
  const code = shipped("src/lib/loginBrand.tsx");
  assert.match(code, /displayName: DEFAULT_BRAND\.displayName,/, "derived, not a second copy");
});

test("a bare brand render is now correct, and the gates are gone", () => {
  // The inverse of what this asserted before, for a reason that is the whole
  // point of the change rather than a relaxation.
  //
  // While DEFAULT_BRAND was Denago, `{brand.displayName}` rendered as raw text
  // was a bug in waiting: it read identically to the literal it replaced and
  // would silently become the neutral platform name later. So every substitution
  // had to sit behind a `brand.branded ?` gate whose false branch was the
  // original string.
  //
  // "Later" is this change. DEFAULT_BRAND is neutral, UNBRANDED derives from it,
  // and a bare render is therefore the CORRECT form — the gates were carrying a
  // Denago literal in every false branch, which is what had to go. Collapsing
  // them leaves one code path instead of two, and it is the path that names
  // whoever the hostname resolved to.
  const gated = [...shipped(STAFF).matchAll(/brand\.branded \?/g)].length
    + [...shipped(PORTAL).matchAll(/brand\.branded \?/g)].length;
  assert.equal(gated, 0, "no ternary should remain — its false branch was the leak");

  // `branded` itself stays on LoginBrand: portalBrand and the app shell still
  // use it to decide whether a tenant resolved at all, which is a different
  // question from what to render.
  assert.match(shipped("src/lib/loginBrand.tsx"), /branded: boolean;/);
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

test("no login page renders a built-in customer logo", () => {
  // The inverse of what this asserted, and the screenshots are why: both login
  // pages showed the Denago wordmark above correctly-neutralised copy — on
  // Acme's hostname and on an unrecognised one alike. The portal page is the
  // worse of the two: it is shown to a tenant's CUSTOMERS.
  for (const file of [STAFF, PORTAL] as const) {
    const code = shipped(file);
    assert.doesNotMatch(code, /\/branding\/denago/, `${file}: no customer artwork as a fallback`);
    assert.match(code, /<BrandLogo\n\s+logoUrl=\{brand\.logoUrl\}/, `${file}: goes through the shared component`);
    assert.match(code, /alt=\{brand\.displayName\}/, `${file}: which sets the NAME when there is no logo`);
    assert.match(code, /\) : null\}/, `${file}: the decorative mark renders nothing rather than someone else's`);
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
