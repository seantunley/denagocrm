import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * Phase 2 of BRANDING-ROADMAP.md — the CRM chrome a tenant's STAFF look at all
 * day.
 *
 * Two things separate it from the login pages (phase 1b):
 *
 *  - The tenant comes from the SESSION, not the hostname. A staff member who
 *    reaches the CRM on the platform's own domain must still see their own
 *    brand; resolving by hostname there would show them the default.
 *  - It is one CSS custom property. The roadmap chose "accent colour + logo"
 *    as the depth precisely because the app is fully tokenised — components
 *    consume `--primary`, not literal colours — so re-theming is an override,
 *    not a rewrite.
 */

test("the CRM shell resolves its brand from the session's tenant, not the hostname", () => {
  const code = shipped("src/app/(app)/layout.tsx");
  assert.match(code, /getActiveTenantId\(\)\s*\.then\(brandForTenant\)/, "session tenant → brand");
  assert.doesNotMatch(code, /brandForHost/, "hostname resolution belongs to the pre-auth pages only");
  assert.match(code, /\.catch\(\(\) => DEFAULT_BRAND\)/, "this layout wraps every page — it cannot throw");
});

test("an unbranded tenant gets no style element in the shell", () => {
  // Same invariant as the login pages: null, not an empty <style>, so the
  // rendered markup is byte-for-byte what shipped before.
  const code = shipped("src/app/(app)/layout.tsx");
  assert.match(code, /const style = brandStyle\(brand\);/);
  assert.match(code, /\{style && <style>\{style\}<\/style>\}/, "no element at all when there is no accent");
});

test("brandForTenant has the same guarantees as brandForHost", () => {
  const code = shipped("src/lib/tenantBrand.ts");
  const start = code.indexOf("export const brandForTenant");
  assert.notEqual(start, -1, "brandForTenant is gone — was it renamed?");
  const body = code.slice(start, code.indexOf("export function brandStyle", start));
  assert.match(body, /basePrisma\.tenant\.findFirst/, "pre-scope read — must survive the restricted role");
  assert.match(body, /active: true/, "a suspended tenant stops branding");
  assert.match(body, /\} catch \{[\s\S]*?return DEFAULT_BRAND;/, "never throws");
  assert.match(body, /brandFromRow\(/, "…and revalidates the colour on read, like every other path");
});

test("the shell logo falls back to the built-in asset", () => {
  const shell = shipped("src/components/AppShell.tsx");
  assert.match(shell, /<BrandLogo/, "both logo sites go through the shared component");
  assert.doesNotMatch(
    shell,
    /src="\/branding\/denago-cape-town-logo\.png"/,
    "AppShell must not hardcode the asset — BrandLogo owns the fallback",
  );
  const component = shipped("src/components/BrandLogo.tsx");
  assert.match(component, /\/branding\/denago-cape-town-logo\.png/, "…and BrandLogo still HAS the fallback");
  assert.match(component, /\/branding\/denago-mark\.png/, "…including the square mark");
  assert.match(component, /if \(logoUrl\) \{/, "the tenant logo is a conditional over the fallback");
});

test("brand is optional on AppShell, so an unbranded render is the old render", () => {
  // Optional rather than required: this component is rendered by tests and by the
  // layout, and a required prop would have forced every caller to invent a value.
  // `undefined` means the built-in assets — exactly today's output.
  const shell = shipped("src/components/AppShell.tsx");
  assert.match(shell, /brand\?: \{ logoUrl: string \| null; displayName: string \}/);
  assert.match(shell, /brand\?\.logoUrl \?\? null/, "absent brand → built-in asset");
  assert.match(shell, /brand\?\.displayName \?\? "Denago Cape Town"/, "absent brand → the original alt text");
});

/**
 * Sites that still hardcode a brand asset, WITH the reason each is not in this
 * phase. The list is asserted so it cannot rot: fix one and this test tells you
 * to remove it from here, add a new hardcoded asset and it tells you to justify
 * it.
 */
const STILL_HARDCODED: Record<string, string> = {
  // Phase 5 (print / documents): the doc-editor canvas, the print shells and the
  // PDF/email renderers. They render a DOCUMENT, whose brand comes from the
  // record being printed rather than from the viewer's session.
  "src/components/doceditor/BlockView.tsx": "phase 5 — document canvas",
  "src/components/print/PrintDocShell.tsx": "phase 5 — print",
  "src/components/print/QuotePrintDoc.tsx": "phase 5 — print",
  "src/lib/customDocs.ts": "phase 5 — print",
  "src/lib/signature.ts": "phase 5 — signed PDFs",
  "src/lib/campaigns.ts": "phase 4 — email",
  "src/app/(print)/jobcards/[id]/print/page.tsx": "phase 5 — print",
  // Already brand-aware via their own mechanism.
  "src/app/login/LoginClient.tsx": "phase 1b — falls back through BrandLogo's own conditional",
  "src/app/portal/login/PortalLoginClient.tsx": "phase 1b — same",
  "src/components/BrandLogo.tsx": "IS the fallback",
  // Deliberately left: a 16px lead-SOURCE glyph meaning "came in via the web
  // form", sitting in a map beside the Facebook/Instagram/WhatsApp marks. Reaching
  // it means drilling a prop three levels through a 1200-line drag-and-drop board,
  // and the honest fix is a generic glyph rather than a logo — which would be a
  // visible change for the current workspace. Revisit with a source-icon set.
  "src/components/KanbanBoard.tsx": "deferred — lead-source glyph, see comment",
  // Per-TEMPLATE logo with its own upload; its fallback should become the
  // tenant's in phase 5 when document branding lands.
  "src/app/(app)/settings/documents/t/[id]/page.tsx": "phase 5 — per-template logo",
};

test("every remaining hardcoded brand asset is accounted for", () => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(root, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(path.join(root, rel)).isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry) && read(rel).includes("branding/denago")) found.push(rel);
    }
  };
  walk("src");

  const unexplained = found.filter((rel) => !(rel in STILL_HARDCODED));
  assert.deepEqual(
    unexplained,
    [],
    `these hardcode a brand asset with no recorded reason — brand them, or add them to STILL_HARDCODED with a phase:\n  ${unexplained.join("\n  ")}`,
  );

  const stale = Object.keys(STILL_HARDCODED).filter((rel) => !found.includes(rel));
  assert.deepEqual(
    stale,
    [],
    `these no longer hardcode anything — remove them from STILL_HARDCODED:\n  ${stale.join("\n  ")}`,
  );
});

test("the CRM shell itself is off that list", () => {
  // The whole point of phase 2. If AppShell ever reappears in the inventory, the
  // shared component has been bypassed.
  assert.ok(!("src/components/AppShell.tsx" in STILL_HARDCODED));
  assert.ok(!("src/app/messages/layout.tsx" in STILL_HARDCODED));
  assert.ok(!("src/app/(app)/layout.tsx" in STILL_HARDCODED));
});
