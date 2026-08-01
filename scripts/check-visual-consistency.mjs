import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sourceRoot = path.join(root, "src");

const rawHeadingAllowlist = new Set([
  // Bespoke workspace headers: the unified job-card page (PR30 design + workshop
  // depth) and the CPQ quote record both use a purpose-built header, not the
  // generic PageHeader/EntityDetailShell.
  "src/app/(app)/jobcards/[id]/page.tsx",
  "src/app/(app)/quotes/[id]/page.tsx",
  "src/app/(app)/bot-builder/[id]/page.tsx",
  // FreeScout-style help-desk ticket detail: bespoke thread + properties layout.
  "src/app/(app)/cases/[id]/page.tsx",
  "src/app/(app)/contacts/[id]/edit/page.tsx",
  "src/app/(app)/contacts/new/page.tsx",
  "src/app/(app)/jobcards/new/page.tsx",
  "src/app/(app)/leads/[id]/edit/page.tsx",
  "src/app/(app)/leads/list/page.tsx",
  "src/app/(app)/leads/new/page.tsx",
  "src/app/(app)/page.tsx",
  "src/app/(app)/search/page.tsx",
  "src/app/(app)/settings/documents/builder/page.tsx",
  "src/app/(app)/settings/documents/t/[id]/page.tsx",
  "src/app/(app)/vehicles/[id]/edit/page.tsx",
]);

// These tables represent dense histories, comparisons, or embedded detail data.
// Ordinary entity lists must use ResponsiveDataView or ResponsiveEntityTable.
const horizontalTableAllowlist = new Set([
  "src/app/(app)/audit/page.tsx",
  "src/app/(app)/campaigns/[id]/page.tsx",
  "src/app/(app)/contacts/page.tsx",
  "src/app/(app)/fleets/[id]/page.tsx",
  "src/app/(app)/forecast/page.tsx",
  "src/app/(app)/journeys/page.tsx",
  "src/app/(app)/leads/[id]/page.tsx",
  "src/app/(app)/quotes/[id]/page.tsx",
  "src/app/(app)/settings/access/page.tsx",
  "src/app/(app)/settings/page.tsx",
  "src/app/(app)/surveys/[id]/page.tsx",
]);

/**
 * Source with comments removed, for the checks that ban a pattern.
 *
 * Those checks regex for CODE, and prose that discusses a banned pattern is not
 * the banned pattern. This repo's comments quote the very things they forbid:
 * doceditor/css.ts and doceditor/model.ts both document the XSS payload
 * `#fff" onmouseover="alert(1)" x="` that is the whole reason those modules
 * exist, and that `alert(` failed this job on main. The alternative — writing
 * security comments that avoid saying `alert(`, `confirm(` or `prompt(` — is a
 * trap that resets every time someone documents a payload properly.
 *
 * Block comments and WHOLE-LINE `//` comments only. Stripping from a mid-line
 * `//` would eat the rest of a real line of code — `fetch("https://x"); alert(1)`
 * would lose its alert — turning a false positive into a false negative, which
 * is the direction that actually matters for a guardrail.
 */
function shipped(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute));
    else if (/\.(?:js|jsx|ts|tsx)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

const failures = [];
for (const absolute of await sourceFiles(sourceRoot)) {
  const relative = path.relative(root, absolute).replaceAll("\\", "/");
  const source = await readFile(absolute, "utf8");
  const code = shipped(source);

  // Bare or window.-prefixed native dialogs only — the negative lookbehind keeps
  // member calls like logger.alert()/confirm()/prompt() on other objects from matching.
  const nativeDialog = code.match(/(?<![.\w])(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
  if (nativeDialog) failures.push(`${relative}: native browser dialogs are not part of the product feedback system`);

  const isStaffRoute = relative.startsWith("src/app/(app)/");
  if (isStaffRoute && relative.endsWith("/page.tsx") && code.includes("<h1") && !rawHeadingAllowlist.has(relative)) {
    failures.push(`${relative}: use PageHeader, EntityDetailShell, or the approved builder workspace header`);
  }

  // Raw `source` on purpose: unlike the two above, hasResponsivePattern is a
  // POSITIVE signal, and stripping comments could only remove it and invent a
  // failure. These two checks stay on the unmodified file.
  const hasHorizontalTable = source.includes("overflow-x-auto") && source.includes("<table");
  const hasResponsivePattern = source.includes("ResponsiveDataView") || source.includes("ResponsiveEntityTable");
  if (relative.endsWith("/page.tsx") && hasHorizontalTable && !hasResponsivePattern && !horizontalTableAllowlist.has(relative)) {
    failures.push(`${relative}: ordinary entity tables need an intentional mobile pattern`);
  }
}

if (failures.length) {
  console.error("Visual consistency checks failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Visual consistency checks passed.");
}
