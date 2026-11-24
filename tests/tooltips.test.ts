import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

/*
 * Sean, 2026-11-24: "update all the tooltips" / "make sure tooltips are in the valid places". A button or link that
 * shows only an icon or a symbol (✕ ↑ ↓ + −) says nothing until you hover it — so it must carry a tooltip (`title`).
 * A screen-reader label (aria-label / sr-only text) alone helps nobody with a mouse.
 */
const files = execSync('git ls-files "src/**/*.tsx"').toString().trim().split("\n");

const ICON_ONLY = /<(button|Button|a|Link)\b((?:[^<>]|\{[^{}]*\})*)>\s*<([A-Z][A-Za-z0-9.]*)\b[^<>]*\/>\s*(?:<span className="sr-only">[^<]*<\/span>\s*)?<\/\1>/g;
const SYMBOL_ONLY = /<(button|Button|a|Link|SaveButton)\b((?:[^<>]|\{[^{}]*\})*)>\s*([✕×⋯…↑↓+−✓]{1,2})\s*<\/\1>/gu;
// A wrapped picture (a logo, a stats card) is not an icon button.
const NOT_AN_ICON = /^(BrandLogo|MetricCard)$/;

test("every icon-only or symbol-only button and link has a tooltip", () => {
  const missing: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const pattern of [ICON_ONLY, SYMBOL_ONLY]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source))) {
        const [, , attributes, inner] = match;
        if (/\btitle=|asChild/.test(attributes)) continue;
        if (pattern === ICON_ONLY && NOT_AN_ICON.test(inner)) continue;
        missing.push(`${file}:${source.slice(0, match.index).split("\n").length}`);
      }
    }
  }
  assert.deepEqual(missing, [], `Add a title="…" saying what it does:\n${missing.join("\n")}`);
});

test("tooltips speak plainly — no internal or developer words", () => {
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/<[a-z][a-z0-9]*\b[^<>]*?\btitle="([^"]+)"/g)) {
      if (/\b(node|tenant|AI proofread|synopsis|JSON|DAX)\b|\/ preview|At\/below/i.test(match[1])) {
        offenders.push(`${file}: "${match[1]}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});
