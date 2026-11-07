import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { currencySymbol, formatZAR } from "../src/lib/format";

/**
 * Money is shown in the WORKSPACE's currency (Settings → Quotes), not always the rand.
 * Multicurrency Phase 0b: formatZAR's default is the rand, so a call that forgets the
 * format silently shows "R" to a ruble workspace. These checks fail on any new one.
 */

// Platform billing is the platform's own currency, on purpose (the proposal's §4.8).
const PLATFORM_BILLING = ["TenantInvoiceDocument.tsx", "settings/plan/page.tsx", "platform/BillingTab.tsx"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}
const files = sourceFiles("src")
  .map((file) => file.split(path.sep).join("/"))
  .filter((file) => file !== "src/lib/format.ts" && !PLATFORM_BILLING.some((billing) => file.endsWith(billing)));

/** Calls of formatZAR( / formatZARCompact( with a single argument, as "file:line". */
function oneArgumentCalls(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  const re = /\bformatZAR(?:Compact)?\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (text.slice(Math.max(0, match.index - 16), match.index).includes("function ")) continue;
    let depth = 1;
    let commas = 0;
    for (let i = match.index + match[0].length; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (c === '"' || c === "'" || c === "`") {
        for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
        continue;
      }
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (c === "," && depth === 1) commas++;
    }
    if (commas === 0) found.push(`${file}:${text.slice(0, match.index).split("\n").length}`);
  }
  return found;
}

test("every money display passes the workspace's format", () => {
  const offenders = files.flatMap(oneArgumentCalls);
  assert.deepEqual(offenders, [], "formatZAR without a format shows the rand to every workspace");
});

test("no money field is labelled with a hand-written (R)", () => {
  const offenders = files.filter((file) => /\(R\)/.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, [], "use currencySymbol(moneyFmt) — the workspace may not use the rand");
});

test("a ruble workspace sees rubles; the rand stays the default", () => {
  assert.match(formatZAR(486100, { currency: "RUB", locale: "ru-RU" }), /4\s?861,00\s?₽/);
  assert.match(formatZAR(100050), /R\s?1\s?000,50/);
  assert.equal(currencySymbol({ currency: "RUB", locale: "ru-RU" }), "₽");
  assert.equal(currencySymbol(), "R");
});
