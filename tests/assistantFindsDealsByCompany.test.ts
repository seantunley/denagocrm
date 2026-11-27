import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Sean, 2026-11-28: asked about "Tekili Farm", the assistant said it could not find a delivery date. The deal is Leon
 * van Rooyen's and Tekili Farm is his COMPANY: the deal lookups matched the lead's name and title and the customer's
 * first and last name, never the company, so it fell back to the customer record — "no deal to report on" — whose
 * quote list has no invoice, deposit or delivery. Every lookup that finds a deal by its customer's name matches the
 * company as well, as the customer lookups always did.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

test("every deal lookup by the customer's name matches their company too", () => {
  const byName = /contact: \{ OR: \[\{ firstName: fuzzy\((\w+)\) \}, \{ lastName: fuzzy\(\1\) \}([^\]]*)\]/g;
  const missing: string[] = [];
  let seen = 0;
  for (const file of sources("src")) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(byName)) {
      seen++;
      if (!/company: fuzzy\(/.test(match[2])) missing.push(`${file}: ${match[0]}`);
    }
  }
  assert.ok(seen >= 5, `expected the deal lookups to be found (saw ${seen})`);
  assert.deepEqual(missing, [], "a deal lookup that ignores the customer's company");
});
