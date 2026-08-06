import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildSignature, DEFAULT_SIGNATURE_COMPANY, signatureCompanyFrom } from "../src/lib/signature";
import { pdfImageHostAllowed } from "../src/lib/pdfImageHosts";
import { domainProof, proofMatches } from "../src/lib/domainCheck";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * Source with the PLATFORM ORIGIN fallback removed.
 *
 * `https://crm.denagocpt.co.za` survives as the last-resort value of
 * NEXT_PUBLIC_APP_URL, and it should: it is this deployment's own address, used
 * when no env var and no tenant domain is available, and removing it would make
 * an unconfigured environment build broken links instead of platform ones. It is
 * not a company being named in a customer's email, which is what the assertions
 * below are about — so it is stripped rather than allowed for, because allowing
 * for it with a looser regex would also stop catching the real thing.
 */
const withoutPlatformOrigin = (rel: string) =>
  shipped(rel).replace(/"https:\/\/crm\.denagocpt\.co\.za"/g, '"<platform-origin>"');

// domainProof is an HMAC over SESSION_SECRET and refuses without one — see the
// 503 test below for why that refusal matters.
process.env.SESSION_SECRET ??= "test-secret-for-domain-proofs";

/**
 * OUTBOUND URLS ON THE TENANT'S OWN ORIGIN.
 *
 * The tracked gap was narrow — "the email signature's social glyphs still load
 * from the platform's host" — and the note filed with it guessed the fix was
 * per-tenant asset hosting.
 *
 * There is no asset-hosting problem. Every tenant domain is attached to the SAME
 * deployment, which is what makes per-tenant login pages work at all, so
 * https://acme-crm.co.za/branding/social-facebook.png already resolves and
 * already serves the same bytes. What was wrong was the BASE URL: every outbound
 * absolute URL was built from NEXT_PUBLIC_APP_URL, so the tenant's domain was
 * used for the browser and never for anything the app sent out.
 *
 * That surface is much larger than three glyphs, and the glyphs are the least
 * visible thing on it:
 *
 *   - the "click here to sign" link in a signature request
 *   - survey invitations
 *   - every click-tracked link and the unsubscribe URL in a campaign
 *   - the logo in a campaign email and in an email signature
 */

/* ── 1. old links must keep working, forever ─────────────────────────────── */

test("nothing redirects, canonicalises, or rejects the platform origin", () => {
  // A signing link emailed last month has the platform host baked into it and
  // may be the only copy the signer has. This changes where NEW links point and
  // nothing else — the platform origin stays a permanently valid way to reach
  // every route. That is the design, not a transition.
  const code = shipped("src/lib/tenantOrigin.ts");
  assert.doesNotMatch(code, /redirect|canonical/i, "no redirect machinery");
  for (const file of ["src/lib/signing/dispatch.ts", "src/lib/signing/approvals.ts", "src/lib/surveys.ts"]) {
    assert.doesNotMatch(shipped(file), /req\.headers|host !==|assertHost/i, `${file} must not gate on the incoming host`);
  }
});

test("an unresolvable tenant falls back to the platform origin, never to nothing", () => {
  const code = shipped("src/lib/tenantOrigin.ts");
  assert.match(code, /const fallback = appBaseUrl\(\);/);
  assert.match(code, /if \(!tenantId\) return fallback;/);
  assert.match(code, /\} catch \{\s*return fallback;/, "a database error must not produce an empty link");
  // Only verified domains of ACTIVE tenants. An unverified row resolving would
  // let a hostname nobody has proven serve a tenant's links.
  assert.match(code, /verifiedAt: \{ not: null \}, tenant: \{ active: true \}/);
  assert.match(code, /orderBy: \{ createdAt: "asc" \}/, "deterministic without a primary flag");
});

/* ── 2. the URL builders ─────────────────────────────────────────────────── */

test("an explicit operator override still wins over the lookup", () => {
  // SIGN_BASE_URL is set by a human who means it. A tenant domain must not
  // quietly override an environment variable someone deliberately configured.
  for (const file of ["src/lib/signing/dispatch.ts", "src/lib/signing/approvals.ts"]) {
    assert.match(
      shipped(file),
      /process\.env\.SIGN_BASE_URL \|\| origin \|\| BASE/,
      `${file}: override, then tenant, then platform`,
    );
  }
});

test("every customer-facing link builder takes an origin", () => {
  assert.match(shipped("src/lib/signing/dispatch.ts"), /export function signUrl\(token: string, origin\?: string \| null\)/);
  assert.match(shipped("src/lib/signing/approvals.ts"), /export function approvalUrl\(token: string, origin\?: string \| null\)/);
  assert.match(shipped("src/lib/surveys.ts"), /export const surveyUrl = \(token: string, origin\?: string \| null\)/);
  // …and every call site passes one.
  assert.match(shipped("src/lib/signing/dispatch.ts"), /signUrl\(r\.token, origin\)/);
  assert.match(shipped("src/lib/signing/approvals.ts"), /approvalUrl\(step\.token, origin\)/);
  assert.match(shipped("src/lib/surveys.ts"), /surveyUrl\(response\.token, origin\)/);
  assert.match(shipped("src/lib/surveyDistributionQueue.ts"), /\$\{sender\.origin\}\/s\/\$\{token\}/);
});

/* ── 3. the emails that carried a hardcoded company ──────────────────────── */

test("the signing invitation names the workspace, not Denago", () => {
  // Of everything the brand work touched this is the least excusable place for a
  // hardcoded name: a request to sign a legal document should say who is asking.
  // It had "DENAGO CAPE TOWN" as a wordmark and "Denago Cape Town — Authorised
  // Denago EV Dealer" in the footer, sent to every tenant's customers.
  const code = withoutPlatformOrigin("src/lib/signing/dispatch.ts");
  assert.doesNotMatch(code, /Denago/i, "no company named by a literal");
  assert.match(code, /brand\.displayName\.toUpperCase\(\)/, "the wordmark is the workspace's");
  assert.match(code, /from \$\{brand\.displayName\}/, "…and so is the plain-text body");
  assert.match(code, /const \{ brand, origin \} = await senderFor\(r\.request\.tenantId\)/);
});

test("approval and survey mail stop signing off as someone else", () => {
  for (const file of ["src/lib/signing/approvals.ts", "src/lib/surveys.ts", "src/lib/surveyDistributionQueue.ts"]) {
    assert.doesNotMatch(withoutPlatformOrigin(file), /Denago/i, `${file} must not name a company`);
  }
});

test("a brand lookup can never stop a send", () => {
  // These run in cron jobs and queue workers with no error boundary and no retry
  // the recipient can trigger. A throw here loses a signature request to
  // decoration.
  for (const file of ["src/lib/signing/dispatch.ts", "src/lib/signing/approvals.ts", "src/lib/surveys.ts", "src/lib/surveyDistributionQueue.ts"]) {
    assert.match(shipped(file), /brandForTenant\([^)]*\)\.catch\(\(\) => DEFAULT_BRAND\)/, `${file}`);
  }
});

/* ── 4. the glyphs — the item this started as ────────────────────────────── */

test("signature glyphs come from the origin they are given", () => {
  const html = buildSignature(
    { name: "Sam", email: "s@e.com", mobile: "0821234567" },
    { ...DEFAULT_SIGNATURE_COMPANY, assetBase: "https://acme-crm.co.za", facebook: "https://fb.com/acme" },
  );
  assert.match(html, /https:\/\/acme-crm\.co\.za\/branding\/social-facebook\.png/);
  assert.match(html, /https:\/\/acme-crm\.co\.za\/branding\/social-whatsapp\.png/);
  assert.doesNotMatch(html, /denagocpt/, "not the platform's hostname");
});

test("an omitted origin is the platform's, so the builder stays pure", () => {
  // buildSignature is called from a client-rendered settings preview as well as
  // from the send path, so it cannot do a lookup. A defaulted field keeps it a
  // string builder and keeps an un-updated caller unchanged.
  const html = buildSignature({ name: "Sam", email: "s@e.com" }, { ...DEFAULT_SIGNATURE_COMPANY, facebook: "https://fb.com/x" });
  assert.match(html, /\/branding\/social-facebook\.png/);
  assert.match(shipped("src/lib/signature.ts"), /company\.assetBase\.trim\(\)\.replace\(\/\\\/\$\/, ""\) \|\| SITE/);
  // A trailing slash on the origin must not produce a double slash in the URL.
  const withSlash = buildSignature(
    { name: "Sam", email: "s@e.com" },
    { ...DEFAULT_SIGNATURE_COMPANY, assetBase: "https://acme.co.za/", facebook: "https://fb.com/x" },
  );
  assert.doesNotMatch(withSlash, /acme\.co\.za\/\/branding/);
});

test("the settings preview and the send path resolve the same origin", () => {
  // The preview is the one screen where you check your signature. If it resolved
  // a different origin it would be the one screen that lies about it.
  assert.equal(signatureCompanyFrom({ ...BLANK_PROFILE }, "https://acme.co.za").assetBase, "https://acme.co.za");
  assert.equal(signatureCompanyFrom({ ...BLANK_PROFILE }).assetBase, "", "omitted means the platform default");
  for (const file of ["src/app/(app)/settings/page.tsx", "src/app/actions/emails.ts"]) {
    assert.match(shipped(file), /signatureCompanyFrom\(profile, await tenantOrigin\(/, `${file}`);
  }
});

/* ── 5. the PDF renderer, which would have dropped the logo silently ─────── */

test("a tenant hostname is a valid image source for the PDF renderer", () => {
  // A document logo on a tenant origin, against a renderer that only trusts
  // NEXT_PUBLIC_APP_URL, is aborted — and an aborted image is not an error, so
  // the PDF is generated, stored and emailed with a blank where the logo was.
  const opts = { appUrl: "https://crm.denagocpt.co.za", tenantHosts: ["acme-crm.co.za"] };
  assert.equal(pdfImageHostAllowed("acme-crm.co.za", opts), true);
  assert.equal(pdfImageHostAllowed("crm.denagocpt.co.za", opts), true, "the platform origin still works");
  // …and it is still an allow-list.
  assert.equal(pdfImageHostAllowed("evil.example.com", opts), false);
  assert.equal(pdfImageHostAllowed("acme-crm.co.za", { appUrl: opts.appUrl }), false, "only when passed in");
});

test("the tenant host list is resolved before the interceptor runs", () => {
  // The request interceptor is synchronous. An await inside it would let the
  // first image through, or abort it while the lookup was still pending.
  const code = shipped("src/lib/customDocs.ts");
  const resolveAt = code.indexOf("const tenantHosts = await verifiedTenantHosts();");
  const interceptAt = code.indexOf("page.on(\"request\"");
  assert.ok(resolveAt !== -1 && interceptAt !== -1);
  assert.ok(resolveAt < interceptAt, "resolved before the browser sees a request");
});

/* ── 6. verifiedAt has to mean something now ─────────────────────────────── */

test("verification proves the hostname reaches THIS deployment", () => {
  // It used to write a timestamp on a platform admin's word. Fine while it only
  // decided whether a login page showed a logo — if the domain was not wired up,
  // nobody could reach the login page to notice. Not fine now: a hostname marked
  // verified but not attached sends every signing link, survey invitation and
  // tracked campaign link for that tenant to an address that does not resolve.
  // Nothing errors. The customer just gets a dead link.
  const code = shipped("src/app/actions/tenantBranding.ts");
  assert.match(code, /const reachable = await hostnameServesThisDeployment\(domain\.hostname\);/);
  assert.match(code, /if \(!reachable\.ok\) throw new ActionRefusal\(reachable\.error\);/);
  // Ordered before the write, or a failed check would verify the domain anyway.
  const checkAt = code.indexOf("const reachable = await hostnameServesThisDeployment");
  const writeAt = code.indexOf("data: { verifiedAt: new Date() }");
  assert.ok(checkAt !== -1 && writeAt !== -1 && checkAt < writeAt);
});

test("the probe cannot be pointed at the private network", () => {
  // The hostname is typed into a form. Without the SSRF guard, "verify this
  // domain" is a request the server will make to any address the admin names,
  // including the cloud metadata endpoint.
  const code = shipped("src/app/actions/tenantBranding.ts");
  assert.match(code, /await safeFetchText\(url, \{ timeoutMs: 8000, maxBytes: 4096/);
  assert.doesNotMatch(code, /await fetch\(/, "never a bare fetch");
});

test("the proof can only be produced by a server holding our key", () => {
  const a = domainProof("acme-crm.co.za");
  const b = domainProof("other.co.za");
  assert.notEqual(a, b, "bound to the hostname, so one proof does not verify another domain");
  assert.equal(domainProof("ACME-CRM.CO.ZA"), a, "case-insensitive, like a hostname");
  assert.equal(proofMatches(a, a), true);
  assert.equal(proofMatches(a, b), false);
  for (const junk of [null, undefined, 42, {}, "", a.slice(0, -1), `${a}x`]) {
    assert.equal(proofMatches(a, junk), false, `${JSON.stringify(junk)} must not match`);
  }
});

test("a deployment with no SESSION_SECRET refuses rather than passing everything", () => {
  // A verifier that treated a proofless 200 as a pass would mark every domain
  // verified on a misconfigured deployment.
  const route = shipped("src/app/api/brand/domain-check/route.ts");
  assert.match(route, /\{ status: 503 \}/);
  assert.match(shipped("src/lib/domainCheck.ts"), /throw new Error\("SESSION_SECRET is not set/);
  assert.match(route, /"Cache-Control": "no-store"/, "a proof must not be cached at an edge");
});

const BLANK_PROFILE = {
  name: "",
  tagline: "",
  address: "",
  phone: "",
  email: "",
  website: "",
  facebook: "",
  instagram: "",
  logoUrl: "",
};
