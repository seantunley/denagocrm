import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { withCompanyDetails, defaultTemplate } from "../src/lib/docTemplates";
import { COMPANY_DEFAULTS, type CompanyProfile } from "../src/lib/companyBrand";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  rel.endsWith(".json")
    ? read(rel)
    : read(rel)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/**
 * Denago's company details, typed into code. Customer-facing output reads these
 * from the tenant's Company Profile (Settings → Company, getCompanyProfile());
 * a literal here is another tenant's customer being told to phone Denago.
 */
const COMPANY_LITERALS =
  /Denago Cape Town|073\s?789\s?3438|M5 Freeway|Maitland|denago_capetown|Denago EV Dealer|denagocpt\.co\.za/i;

/**
 * Files allowed to contain one, and why. Every entry must still match — fix
 * one and this test tells you to delete it here; add a new literal anywhere
 * else and it fails.
 */
const ALLOWED: Record<string, string> = {
  // Staff-only screens: example placeholders and the platform's own webhook URLs.
  "src/app/(app)/settings/company/page.tsx": "staff — example placeholders on the Company Profile form",
  "src/app/(app)/settings/helpdesk/page.tsx": "staff — example placeholder",
  "src/app/(app)/settings/page.tsx": "staff — SMTP/IMAP example placeholders and the platform's webhook URLs",
  "src/app/(print)/manual/page.tsx": "staff — the printed user manual",
  "src/app/manifest.ts": "staff — PWA install description",
  "src/app/messages/manifest.webmanifest/route.ts": "staff — PWA install description",
  "src/components/AppShell.tsx": "staff — logo alt fallback, pinned by appShellBranding.test.ts",
  "src/components/quotes/QuoteEditorDialog.tsx": "staff — in-editor preview header (the printed quote reads the profile)",
  "src/lib/help/data/admin.json": "staff — help centre",
  "src/lib/help/data/channels.json": "staff — help centre (platform webhook URLs)",
  "src/lib/help/data/marketing.json": "staff — help centre",
  "src/lib/ai.ts": "staff — proofreading prompt context, never sent to a customer",
  "src/lib/researchPrompt.ts": "staff — lead-research prompt context",
  "src/lib/webauthn.ts": "staff — passkey relying-party name",
  "src/lib/provisioning.ts": "seed — the founding tenant's own row",
  // The PLATFORM's origin (crm.denagocpt.co.za), not a company detail: a fallback
  // when NEXT_PUBLIC_APP_URL is unset. Tenant links go through tenantOrigin().
  "src/lib/campaigns.ts": "platform origin fallback",
  "src/lib/competitors.ts": "platform origin in a crawler User-Agent",
  "src/lib/customDocs.ts": "platform origin fallback",
  "src/lib/integrationProbe.ts": "platform origin fallback",
  "src/lib/pdfImageHosts.ts": "platform origin fallback",
  "src/lib/push.ts": "platform VAPID contact",
  "src/lib/safeFetch.ts": "platform origin in a crawler User-Agent",
  "src/lib/securityRunbook.ts": "platform origin fallback",
  "src/lib/signature.ts": "platform origin fallback for hosted social glyphs",
  "src/lib/signing/approvals.ts": "platform origin fallback",
  "src/lib/signing/dispatch.ts": "platform origin fallback (signing email templates are being made editable separately)",
  "src/lib/surveys.ts": "platform origin fallback",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(path.join(root, rel)).isDirectory()) sourceFiles(rel, out);
    else if (/\.(tsx?|json)$/.test(entry)) out.push(rel);
  }
  return out;
}

test("no customer-facing source hard-codes Denago's company details", () => {
  const hits = sourceFiles("src").filter((rel) => COMPANY_LITERALS.test(shipped(rel)));
  const unexplained = hits.filter((rel) => !(rel in ALLOWED));
  assert.deepEqual(
    unexplained,
    [],
    `read these from getCompanyProfile() instead of typing them in (or, if staff-only, add to ALLOWED with a reason):\n  ${unexplained.join("\n  ")}`,
  );
  const stale = Object.keys(ALLOWED).filter((rel) => !hits.includes(rel));
  assert.deepEqual(stale, [], `no longer hard-coded — remove from ALLOWED:\n  ${stale.join("\n  ")}`);
});

const ACME: CompanyProfile = {
  ...COMPANY_DEFAULTS,
  name: "Acme Golf Carts",
  tagline: "Fleet sales & service",
  address: "1 Fairway Road, Somerset West",
  phone: "021 555 0100",
  email: "hi@acme.co.za",
  website: "acme.co.za",
};

test("document template defaults print the workspace's own details", () => {
  for (const key of ["agreement", "indemnity", "warranty-claim", "quote"] as const) {
    const tpl = withCompanyDetails(defaultTemplate(key), ACME);
    const text = [tpl.intro, tpl.bodyText, tpl.terms, ...tpl.footerLines].join("\n");
    assert.doesNotMatch(text, /Denago|\{\{company\./, `${key}: no Denago and no unfilled token`);
    assert.deepEqual(tpl.footerLines, ["1 Fairway Road, Somerset West · 021 555 0100", "hi@acme.co.za · acme.co.za"]);
  }
  assert.match(withCompanyDetails(defaultTemplate("indemnity"), ACME).bodyText ?? "", /Acme Golf Carts, its owners/);
  // An owner's own footer lines are kept, not replaced by the profile.
  const own = withCompanyDetails({ ...defaultTemplate("quote"), footerLines: ["Custom line"] }, ACME);
  assert.deepEqual(own.footerLines, ["Custom line"]);
});
