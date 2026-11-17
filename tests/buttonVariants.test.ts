import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buttonVariants } from "../src/components/ui/button";

// Sean, 2026-11-16: "buttons are also not the same size" — a link styled as a small button kept the base min-h-9
// beside its size's min-h-8, and stood 4px taller than the real buttons next to it.
test("a button style used on a link carries ONE height: its size's", () => {
  const heights = (classes: string) => classes.split(/\s+/).filter((c) => /^min-h-/.test(c));
  assert.deepEqual(heights(buttonVariants({ variant: "outline", size: "sm" })), ["min-h-8"]);
  assert.deepEqual(heights(buttonVariants({ size: "lg" })), ["min-h-10"]);
  assert.deepEqual(heights(buttonVariants({ size: "xs" })), ["min-h-6"]);
  assert.deepEqual(heights(buttonVariants()), ["min-h-9"], "the default keeps the base height");
});

test("the quote register's Open deal matches Send and PDF: an icon, the same size, the same gap", () => {
  const page = readFileSync("src/app/(app)/quotes/page.tsx", "utf8");
  const links = page.match(/<Link href=\{`\/deals\/\$\{quote\.id\}`\}[^>]*>.*?<\/Link>/g) ?? [];
  assert.equal(links.length, 2);
  for (const link of links) assert.match(link, /buttonVariants\(\{ variant: "outline", size: "sm" \}\).*><FolderOpen \/>Open deal<\/Link>/);
  assert.match(page, /\} mr-2`\}><FolderOpen \/>Open deal/, "8px, like the gap between Send, PDF and ⋯");
});
