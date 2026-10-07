import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/*
 * 2026-10-07: "Check my message" rendered its own <form> inside the email
 * composer's (and the inbox reply's) form — invalid HTML that React reported as
 * a hydration error on the lead page. A browser may drop the inner form, and the
 * button then submits the OUTER one: it would send the email instead of
 * checking it. It is a plain button now.
 */
const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("Check my message is a plain button, never a form", () => {
  const button = code("src/components/AiCheckButton.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(button, /<form\b/);
  assert.match(button, /<button\s+type="button"\s+onClick=\{run\}/);
  assert.match(button, /startTransition\(\(\) => check\(fd\)\)/);
});

test("both places that use it are inside a form of their own", () => {
  for (const rel of ["src/components/EmailComposer.tsx", "src/components/InboxReply.tsx"]) {
    const src = code(rel);
    assert.match(src, /<AiCheckButton/, rel);
    assert.match(src, /<form\b/, `${rel} has its own form — which is why the button may not`);
  }
});
