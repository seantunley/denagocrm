import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/*
 * A table inside the bordered ResponsiveEntityTable box needs side padding on its cells, or its first and last
 * columns sit on the border (Sean, 2026-11-05: "Priority is nudging up against the edge" on the chatbot's entry
 * routes). The shared `table-base` class gives every cell px-3; a table that turns the box's border off
 * ("border-0") sits flush on purpose. Any other table in the box must use table-base or pad its own cells.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".tsx") ? [path] : [];
  });
}

test("every table in a bordered entity-table box pads its cells", () => {
  const offenders: string[] = [];
  for (const file of sources("src")) {
    const code = readFileSync(file, "utf8");
    for (const match of code.matchAll(/<ResponsiveEntityTable([^>]*)>\s*(?:\{[^}]*\}\s*)?<table className="([^"]*)"/g)) {
      const box = match[1];
      const table = match[2];
      if (/border-0/.test(box)) continue;
      const after = code.slice(match.index! + match[0].length, match.index! + match[0].length + 1500);
      const firstHeader = /<th className="([^"]*)"/.exec(after)?.[1] ?? "";
      if (!/\btable-base\b/.test(table) && !/\bpx-\d|\bpl-\d/.test(firstHeader)) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], "use table-base (or pad the cells) so the first and last columns don't touch the border");
});
