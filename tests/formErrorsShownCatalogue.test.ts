import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #22, competitors + products: a thrown server-action Error reaches
// staff as the generic "This page hit an error" in production. These modules now
// return refusals and their forms show them. Pinned so they can't drift back.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const CONVERTED: Array<{ actions: string; forms: string[] }> = [
  {
    actions: "src/app/actions/competitors.ts",
    forms: ["src/app/(app)/competitors/page.tsx", "src/app/(app)/competitors/[id]/page.tsx"],
  },
  {
    actions: "src/app/actions/products.ts",
    forms: ["src/app/(app)/products/[id]/page.tsx", "src/components/ProductForm.tsx", "src/components/ProductShowcaseForm.tsx"],
  },
];

for (const { actions, forms } of CONVERTED) {
  test(`${actions}: every action returns its refusal instead of throwing`, () => {
    const s = src(actions);
    assert.doesNotMatch(s, /throw new Error\(/);
    assert.doesNotMatch(s, /withActingStaffScope\(async/);
    assert.doesNotMatch(s, /\bredirect\(/, "navigate with { redirectTo } — SaveForm ignores a thrown redirect");
  });
  for (const form of forms) {
    test(`${form}: no bare <form action>`, () => {
      assert.doesNotMatch(src(form), /<form[^>]*\baction=\{/);
    });
  }
}

test("AI discovery / research failures are reported, not silently 'done'", () => {
  const s = src("src/app/actions/competitors.ts");
  assert.match(s, /if \(!result\.ok\) refuse\("AI discovery couldn't finish/);
  assert.match(s, /if \(!result\.ok\) refuse\("AI research couldn't finish/);
});

test("a bad showcase photo shows its size/format message", () => {
  assert.match(src("src/app/actions/products.ts"), /checked = checkShowcaseImage\(buffer\);[\s\S]*?refuse\(error instanceof Error \? error\.message/);
});
