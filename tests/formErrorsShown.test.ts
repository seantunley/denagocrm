import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #22: a server action that THROWS reaches the browser, in production,
// as the generic "This page hit an error" — Next replaces the message with a
// digest. A refusal has to come back as a value, and the form has to show it.
// Converted module by module; each one converted is pinned here so it can't
// drift back.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const CONVERTED: Array<{ actions: string; forms: string[] }> = [
  {
    actions: "src/app/actions/testDrives.ts",
    forms: [
      "src/app/(app)/test-drives/[id]/page.tsx",
      "src/app/(app)/test-drives/demo-fleet/page.tsx",
      "src/components/test-drives/TestDriveBookingTrigger.tsx",
    ],
  },
];

for (const { actions, forms } of CONVERTED) {
  test(`${actions}: every action returns its refusal instead of throwing`, () => {
    const s = src(actions);
    assert.doesNotMatch(s, /throw new Error\(/, "a thrown Error shows the generic error page");
    assert.doesNotMatch(s, /withActingStaffScope\(async/, "asActionResult binds the acting workspace AND returns { error }");
    assert.doesNotMatch(s, /\bredirect\(/, "navigate with { redirectTo } — SaveForm ignores a thrown redirect");
  });
  for (const form of forms) {
    test(`${form}: forms show the action's message (SaveForm), never a bare <form action>`, () => {
      assert.doesNotMatch(src(form), /<form[^>]*\baction=\{/);
    });
  }
}
