import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sourceRoot = path.join(root, "src");

const rawHeadingAllowlist = new Set([
  "src/app/(app)/bot-builder/[id]/page.tsx",
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

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

const failures = [];
for (const absolute of await sourceFiles(sourceRoot)) {
  const relative = path.relative(root, absolute).replaceAll("\\", "/");
  const source = await readFile(absolute, "utf8");

  const nativeDialog = source.match(/\b(?:window\.)?(?:alert|prompt)\s*\(|\bwindow\.confirm\s*\(/);
  if (nativeDialog) failures.push(`${relative}: native browser dialogs are not part of the product feedback system`);

  const isStaffRoute = relative.startsWith("src/app/(app)/");
  if (isStaffRoute && relative.endsWith("/page.tsx") && source.includes("<h1") && !rawHeadingAllowlist.has(relative)) {
    failures.push(`${relative}: use PageHeader, EntityDetailShell, or the approved builder workspace header`);
  }

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
