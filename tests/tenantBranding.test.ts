import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  DEFAULT_BRAND,
  brandFromRow,
  brandLogoUrl,
  brandStyle,
  isBrandColour,
  normaliseHost,
  textOn,
} from "../src/lib/tenantBrand";
import { PLATFORM_NAME } from "../src/lib/platformIdentity";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * Per-tenant branding, and the two properties that make it safe to merge into a
 * live single-tenant production system:
 *
 *   1. With no brand set — which is every tenant the moment this deploys —
 *      every surface renders exactly what it rendered before.
 *   2. The accent colour reaches a stylesheet, so it is untrusted at both ends.
 */

/* ── 1. nothing changes until someone sets something ─────────────────────── */

test("a tenant with no brand set renders exactly what it rendered before", () => {
  const brand = brandFromRow({
    tenantId: "t1",
    brandPrimary: null,
    brandLogoRef: null,
    brandDisplayName: null,
    brandTagline: null,
  });
  assert.equal(brand.displayName, DEFAULT_BRAND.displayName);
  assert.equal(brand.tagline, DEFAULT_BRAND.tagline);
  assert.equal(brand.primary, null, "no accent means NO override, not a default colour");
  assert.equal(brand.primaryForeground, null);
  assert.equal(brand.logoRef, null);
  // The whole point: no style element is emitted at all, so the markup is
  // byte-for-byte what shipped before branding existed.
  assert.equal(brandStyle(brand), null, "an unbranded tenant must emit no <style> element");
  assert.equal(brandLogoUrl(brand), null, "…and no logo URL, so the built-in asset is used");
});

test("blank strings are treated as unset, not as content", () => {
  // An admin who clears a field must get the default back, not an empty heading.
  const brand = brandFromRow({
    tenantId: "t1",
    brandPrimary: "",
    brandLogoRef: "   ",
    brandDisplayName: "   ",
    brandTagline: "",
  });
  assert.equal(brand.displayName, DEFAULT_BRAND.displayName);
  assert.equal(brand.tagline, DEFAULT_BRAND.tagline);
  assert.equal(brand.primary, null);
  assert.equal(brand.logoRef, null);
});

test("the default brand names the PLATFORM, never a tenant", () => {
  // This test used to assert the reverse, and said so: a neutral fallback is
  // right for a white-label platform, but could not ship in the same change as
  // the schema, because until Denago's hostnames were registered the live
  // workspace resolved to nobody and would have rebranded itself on deploy.
  //
  // 20260806190000_seed_founding_tenant_brand registers them, in the same change,
  // and migrations run before the new build serves. The precondition is met.
  //
  // `branded: false` is reachable in exactly three situations — an unrecognised
  // hostname, a tenant that could not be resolved, and a swallowed database
  // error. In all three the old value showed ONE customer's trading name to
  // somebody who is not their customer.
  assert.equal(DEFAULT_BRAND.displayName, PLATFORM_NAME);
  assert.equal(DEFAULT_BRAND.tagline, null, "nothing true to say about a company we cannot identify");
  assert.equal(DEFAULT_BRAND.primary, null);
  assert.equal(DEFAULT_BRAND.tenantId, null);

  // The specific regression: no customer's identity anywhere in the fallback.
  const source = read("src/lib/tenantBrand.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const block = source.slice(source.indexOf("export const DEFAULT_BRAND"), source.indexOf("const HEX"));
  assert.doesNotMatch(block, /Denago/i);
});

test("Denago keeps its brand because it is seeded, not because it is the default", () => {
  // The whole safety argument for the change above. If this migration did not
  // exist, or stopped setting these, the live workspace would go neutral on the
  // next deploy — silently, because every test would still pass.
  const sql = read("prisma/migrations/20260806190000_seed_founding_tenant_brand/migration.sql");
  assert.match(sql, /UPDATE "Tenant"/);
  assert.match(sql, /'Denago Cape Town'/, "the display name it renders today");
  assert.match(sql, /'Authorized Denago EV Dealer'/, "…and the tagline");

  // Without a VERIFIED hostname row, brandForHost resolves nobody and the login
  // page goes neutral. This row is what stops that.
  assert.match(sql, /INSERT INTO "TenantDomain"/);
  assert.match(sql, /'crm\.denagocpt\.co\.za', NOW\(\)/, "verified, not pending");

  // Production had ZERO COMPANY_* settings when this was written, so every
  // document was resolving through COMPANY_DEFAULTS. Neutralising that constant
  // without these rows blanks the footer of every quote and signed agreement.
  assert.match(sql, /INSERT INTO "AppSetting"/);
  for (const key of ["COMPANY_NAME", "COMPANY_ADDRESS", "COMPANY_PHONE", "COMPANY_EMAIL", "COMPANY_WEBSITE"]) {
    assert.match(sql, new RegExp(`'${key}'`), `${key} must be seeded`);
  }

  // The one row that is not a straight copy of COMPANY_DEFAULTS, and the only
  // part of this change that would DEGRADE rather than rename. The signature
  // resolved `profile.logoUrl || DEFAULT_SIGNATURE_COMPANY.logoUrl`, and that
  // second operand was the built-in Denago asset — now empty. Without this row
  // every Denago email signature goes out with no logo.
  assert.match(
    sql,
    /'COMPANY_LOGO_URL',\s+'https:\/\/crm\.denagocpt\.co\.za\/branding\/denago-logo-email\.png'/,
    "the signature logo must survive the neutral default",
  );

  // Nothing overwrites a value a human has already set.
  assert.match(sql, /COALESCE\("brandDisplayName"/);
  assert.match(sql, /ON CONFLICT \("hostname"\) DO NOTHING/);
  assert.match(sql, /ON CONFLICT \("tenantId", "key"\) DO NOTHING/);
});

/* ── 2. the colour is untrusted at both ends ─────────────────────────────── */

test("only #rrggbb is a brand colour", () => {
  for (const good of ["#ea580c", "#000000", "#FFFFFF", "#AbCdEf"]) {
    assert.equal(isBrandColour(good), true, `${good} should be accepted`);
  }
  for (const bad of [
    "#fff", // shorthand — not what the stylesheet interpolation expects
    "ea580c", // no hash
    "#ea580cc", // too long
    "red",
    "rgb(1,2,3)",
    "var(--x)",
    "#ea580c;}body{display:none", // the injection this exists to stop
    "#ea580c;background:url(//evil)",
    "",
    null,
    undefined,
    123,
    {},
  ]) {
    assert.equal(isBrandColour(bad as unknown), false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("a colour that somehow reached the column still cannot reach the stylesheet", () => {
  // Read-side validation, not just write-side. A bad migration, a direct SQL
  // edit or a future writer that forgets must not be able to poison the page.
  const brand = brandFromRow({
    tenantId: "t1",
    brandPrimary: "#ea580c;}body{display:none}",
    brandLogoRef: null,
    brandDisplayName: null,
    brandTagline: null,
  });
  assert.equal(brand.primary, null, "an invalid stored colour is dropped on read");
  assert.equal(brandStyle(brand), null, "…so no style element is emitted at all");
});

test("the emitted stylesheet contains nothing but the two validated values", () => {
  const brand = brandFromRow({
    tenantId: "t1",
    brandPrimary: "#ea580c",
    brandLogoRef: null,
    brandDisplayName: null,
    brandTagline: null,
  });
  const css = brandStyle(brand);
  assert.equal(css, ":root{--primary:#ea580c;--primary-foreground:#ffffff}");
  assert.doesNotMatch(css ?? "", /[<>"']/, "nothing that could break out of a <style> element");
});

/* ── readable text is computed, never stored ─────────────────────────────── */

test("text colour is derived from the accent's luminance", () => {
  assert.equal(textOn("#000000"), "#ffffff", "black accent → white text");
  assert.equal(textOn("#ffffff"), "#0f172a", "white accent → dark text");
  assert.equal(textOn("#ffff00"), "#0f172a", "yellow is light — dark text, never white");
  assert.equal(textOn("#1e3a8a"), "#ffffff", "deep blue → white text");
  // The failure this prevents: a stored foreground that disagrees with the
  // accent. There is no way to store one, so there is no way to disagree.
  const brand = brandFromRow({
    tenantId: "t1",
    brandPrimary: "#ffff00",
    brandLogoRef: null,
    brandDisplayName: null,
    brandTagline: null,
  });
  assert.equal(brand.primaryForeground, "#0f172a");
});

/* ── hostnames ───────────────────────────────────────────────────────────── */

test("hostnames normalise so one address cannot become two rows", () => {
  assert.equal(normaliseHost("ACME.co.za"), "acme.co.za");
  assert.equal(normaliseHost("acme.co.za:443"), "acme.co.za");
  assert.equal(normaliseHost("  Acme.CO.za.  "), "acme.co.za");
  assert.equal(normaliseHost("acme.co.za"), "acme.co.za");
  // IPv6 literals round-trip rather than being mangled into a non-match.
  assert.equal(normaliseHost("[::1]:3000"), "[::1]");
  for (const empty of ["", "   ", null, undefined, 42 as unknown as string]) {
    assert.equal(normaliseHost(empty), null);
  }
});

test("the logo URL changes when the logo does, so 'immutable' caching is honest", () => {
  const base = { tenantId: "t1", brandPrimary: null, brandDisplayName: null, brandTagline: null };
  const a = brandLogoUrl(brandFromRow({ ...base, brandLogoRef: "branding/t1/logo-1.png" }));
  const b = brandLogoUrl(brandFromRow({ ...base, brandLogoRef: "branding/t1/logo-2.png" }));
  assert.ok(a && b);
  assert.notEqual(a, b, "a new upload must be a new URL — the route sends immutable");
  // `?a=` names the immutable asset the route resolves. It used to be `?v=`, a
  // hash of the ref that only LOOKED versioned — the route ignored it and served
  // the current logo, so the immutable cache header was a promise the response
  // did not keep.
  assert.match(a, /^\/api\/brand\/logo\/t1\?a=logo-/);
});

/* ── structural: the properties above must stay true in the shipped code ─── */

test("the brand lookup can never take the login page down", () => {
  // It runs on /login. A brand lookup that throws is a lockout of the whole
  // workspace for a decorative feature.
  const code = shipped("src/lib/tenantBrand.ts");
  const start = code.indexOf("export const brandForHost");
  assert.notEqual(start, -1, "brandForHost is gone — was it renamed?");
  const body = code.slice(start);
  assert.match(body, /try \{/, "the lookup must be wrapped");
  assert.match(body, /\} catch \{[\s\S]*?return DEFAULT_BRAND;/, "every failure returns the default");
  assert.doesNotMatch(body, /throw /, "nothing in the lookup may throw");
});

test("the pre-auth lookup uses basePrisma, and requires a VERIFIED domain", () => {
  const code = shipped("src/lib/tenantBrand.ts");
  assert.match(
    code,
    /basePrisma\.tenantDomain\.findFirst/,
    "a login page has no tenant scope — the scoped client would fail closed under enforcement",
  );
  assert.match(
    code,
    /verifiedAt: \{ not: null \}/,
    "an unverified hostname is one somebody CLAIMED — honouring it lets a tenant brand an address they do not control",
  );
  assert.match(code, /tenant: \{ active: true \}/, "a suspended tenant must not keep serving its brand");
});

test("every branding write authorises before it refuses", () => {
  // Same rule saveFeedback.test.ts enforces elsewhere: a refusal is a reply, and
  // replying to an unauthorised caller confirms the endpoint responds.
  const code = shipped("src/app/actions/tenantBranding.ts");
  const exports = [...code.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
  assert.ok(exports.length >= 6, `expected the branding actions, found ${exports.join(", ")}`);
  for (const name of exports) {
    const start = code.indexOf(`export async function ${name}(`);
    const next = code.indexOf("export async function ", start + 1);
    const body = code.slice(start, next === -1 ? undefined : next);
    const gate = body.indexOf("await requirePlatformAdminAction()");
    const refusal = body.indexOf("ActionRefusal");
    assert.ok(gate !== -1, `${name} does not authorise at all`);
    assert.ok(refusal === -1 || gate < refusal, `${name} refuses before authorising`);
  }
});

test("a hostname is never silently reassigned between tenants", () => {
  // The ChannelIdentity backfill shipped with exactly this bug: an upsert that
  // moved an ownership mapping from one tenant to another without saying so.
  const code = shipped("src/app/actions/tenantBranding.ts");
  const start = code.indexOf("export async function addTenantDomainAction(");
  const body = code.slice(start, code.indexOf("export async function verifyTenantDomainAction(", start));
  assert.match(body, /already registered to another tenant/, "a conflict must be refused, loudly");
  assert.doesNotMatch(body, /upsert/, "an upsert here would overwrite the mapping instead of refusing");
  assert.doesNotMatch(
    body,
    /verifiedAt:\s*new Date\(\)/,
    "a hostname must be added UNVERIFIED — verification is a separate, audited step",
  );
});

test("domain actions check the domain belongs to the tenant in the URL", () => {
  // Fetching by id alone lets a forged POST verify or delete another tenant's
  // hostname — and a hostname is what decides whose brand an address serves.
  const code = shipped("src/app/actions/tenantBranding.ts");
  for (const name of ["verifyTenantDomainAction", "removeTenantDomainAction"]) {
    const start = code.indexOf(`export async function ${name}(`);
    const next = code.indexOf("export async function ", start + 1);
    const body = code.slice(start, next === -1 ? undefined : next);
    assert.match(
      body,
      /domain\.tenantId !== tenantId/,
      `${name} must confirm the domain belongs to this tenant`,
    );
  }
});

test("the migration is additive only", () => {
  // It runs against production while the PREVIOUS build is still serving.
  const sql = read("prisma/migrations/20260806140000_tenant_branding/migration.sql");
  assert.doesNotMatch(sql, /\bDROP TABLE\b|\bDROP COLUMN\b|\bALTER COLUMN\b|\bSET NOT NULL\b/i);
  for (const added of ["brandPrimary", "brandLogoRef", "brandDisplayName", "brandTagline"]) {
    assert.match(
      sql,
      new RegExp(`ADD COLUMN IF NOT EXISTS "${added}"\\s+TEXT;`),
      `${added} must be added as a nullable TEXT column`,
    );
  }
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "TenantDomain"/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "TenantDomain_hostname_key"/);
  // FORCE RLS is live on 120 tables; a new table without a policy has no
  // DB-layer boundary at all.
  assert.match(sql, /ALTER TABLE "TenantDomain" ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE "TenantDomain" FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE POLICY "TenantDomain_tenant_isolation"/);
});

test("the logo route serves only what a platform admin stored", () => {
  const code = shipped("src/app/api/brand/logo/[tenantId]/route.ts");
  // The caller supplies a tenant id, never a blob ref — so it cannot be steered
  // at an arbitrary object.
  assert.doesNotMatch(code, /searchParams\.get\("(ref|path|file)"\)/);
  assert.match(code, /brandLogoRef/, "the ref comes from the column, not the request");
  assert.match(code, /EXT_TYPES\[ext\]/, "the content type is pinned to the upload allow-list");
  assert.match(code, /X-Content-Type-Options/, "…and sent with nosniff");
  assert.match(code, /active: true|tenant\?\.active/, "a suspended tenant stops serving its brand");
});
