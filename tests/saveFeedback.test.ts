import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

// ── Expected refusals must travel as VALUES, never as throws ────────────────

// Next.js does not send a thrown server-action error's message to the browser in
// production — it substitutes an opaque digest. Every guard message in the
// console ("That user already belongs to another tenant", "Cannot remove the
// tenant owner") would therefore have been replaced by a generic apology exactly
// where it matters. Refusals must be returned.
for (const file of ["src/app/actions/tenants.ts", "src/app/actions/platformAdmins.ts"]) {
  test(`${file}: refusals are returned as values, not thrown as Error`, () => {
    const code = src(file);
    assert.doesNotMatch(
      code,
      /throw new Error\(/,
      "a thrown Error loses its message in production; use ActionRefusal so it is returned as { error }",
    );
    assert.match(code, /asActionResult\(/, "action bodies must be wrapped so refusals become values");
  });
}

test("actionResult: only ActionRefusal is converted; everything else rethrows", () => {
  const code = src("src/lib/actionResult.ts");
  assert.match(code, /error instanceof ActionRefusal/, "only marked refusals may be shown to the user");
  assert.match(code, /throw error/, "unexpected errors must keep propagating to the boundary and the logs");
});

// ── SaveForm contract ──────────────────────────────────────────────────────

test("SaveForm: unknown throws produce a GENERIC message, never a raw one", () => {
  const code = src("src/components/SaveForm.tsx");
  assert.match(code, /toast\.error\(GENERIC_FAILURE\)/, "unexpected failures must not render server internals or a digest");
  assert.doesNotMatch(
    code,
    /toast\.error\(\s*messageFor/,
    "messages extracted from thrown errors are digests in production",
  );
});

test("SaveForm: redirect()/notFound() are rethrown, not reported as failures", () => {
  const code = src("src/components/SaveForm.tsx");
  assert.match(code, /isNextControlFlow\(error\)\)\s*throw error/, "control-flow throws are successful outcomes");
  assert.match(code, /NEXT_REDIRECT\|NEXT_NOT_FOUND/, "both control-flow signals must be recognised");
});

// The form element is nulled once the handler returns, so a reference taken after
// the await would throw — and the reset would silently never happen.
test("SaveForm: the form is captured BEFORE awaiting the action", () => {
  const code = src("src/components/SaveForm.tsx");
  const capture = code.indexOf("const form = event.currentTarget");
  const await1 = code.indexOf("await action(formData)");
  assert.ok(capture > 0, "the form element must be captured");
  assert.ok(capture < await1, "it must be captured before the await, not after");
});

// A create form that stays populated after succeeding invites a duplicate
// submission, and leaves a typed PASSWORD sitting in a visible field.
test("SaveForm: clears fields and closes the modal on success, by default", () => {
  const code = src("src/components/SaveForm.tsx");
  assert.match(code, /resetOnSuccess = true/, "clearing after success must be the default");
  assert.match(code, /closeModalOnSuccess = true/, "closing the modal after success must be the default");
  assert.match(code, /if \(resetOnSuccess\) form\.reset\(\)/, "the reset must actually run");
});

// Edit-style forms must opt OUT, or they snap back to the values the page was
// rendered with instead of showing what was just saved.
test("the module grant grid opts out of reset (it edits rather than creates)", () => {
  const code = src("src/app/platform/(console)/tenants/[id]/page.tsx");
  assert.match(code, /resetOnSuccess=\{false\}/, "the modules form must not reset after saving");
});
