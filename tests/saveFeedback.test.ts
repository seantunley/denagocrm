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

// redirect() and notFound() both throw, but they are NOT the same outcome. A
// redirect is the success path for every action that navigates to the saved
// record (createLead, updateLead, markWon…) — it throws before the success toast
// would run, so those saves confirmed nothing until it was handled explicitly.
// notFound() must never be congratulated.
test("SaveForm: a redirect toasts success before navigating; notFound does not", () => {
  const code = src("src/components/SaveForm.tsx");
  assert.match(code, /NEXT_REDIRECT/, "the redirect signal must be recognised");
  assert.match(code, /NEXT_NOT_FOUND/, "the not-found signal must be recognised");

  const redirectBranch = code.slice(
    code.indexOf('if (control === "redirect")'),
    code.indexOf('if (control === "not-found")'),
  );
  assert.ok(redirectBranch.length > 0, "the redirect branch must exist");
  assert.match(redirectBranch, /toast\.success\(success\)/, "a redirect is a successful save");
  assert.match(redirectBranch, /throw error/, "and must still rethrow so Next navigates");

  const notFoundBranch = code.slice(code.indexOf('if (control === "not-found")'));
  assert.doesNotMatch(
    notFoundBranch.slice(0, 200),
    /toast\.success/,
    "landing on a 404 is not a success",
  );
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

// ── Secrets must not survive a save in the DOM ──────────────────────────────

// Settings forms EDIT, so they set resetOnSuccess={false} to keep showing what
// was saved — which left a just-typed SMTP/IMAP password or API token sitting in
// the input afterwards. Those fields are write-only (they render a
// "•••••••• saved" placeholder, never the stored value), so clearing them
// restores exactly what the page renders with.
test("SaveForm: password inputs are cleared on success even without a reset", () => {
  const code = src("src/components/SaveForm.tsx");
  const clear = code.indexOf('input[type="password"]');
  assert.ok(clear > 0, "password inputs must be cleared explicitly");
  const resetGuard = code.indexOf("if (resetOnSuccess) form.reset()");
  assert.ok(
    clear > resetGuard,
    "clearing must happen OUTSIDE the resetOnSuccess guard, or forms that keep their values keep the secret too",
  );
});

// ── A no-op must never be reported as a success ────────────────────────────

// asActionResult resolves any normal return as success, so a silent early return
// produced a confident lie — "Deleted" for a stage that still holds leads being
// the worst of them.
for (const file of [
  "src/app/actions/settings.ts",
  "src/app/actions/pipelines.ts",
  "src/app/actions/emails.ts",
  "src/app/actions/ai.ts",
]) {
  test(`${file}: converted actions have no silent early returns`, () => {
    const code = src(file);
    const inWrapped = code.split("return asActionResult(async () => {").slice(1);
    for (const block of inWrapped) {
      const body = block.split("\n  });")[0];
      assert.doesNotMatch(
        body,
        /^\s+(if \(.*\) )?return;\s*$/m,
        "a bare `return` inside a wrapped action resolves as success; refuse() or return { success } instead",
      );
    }
  });
}

test("deleteStage refuses rather than silently doing nothing when leads remain", () => {
  const code = src("src/app/actions/settings.ts");
  assert.match(code, /if \(count > 0\) refuse\(/, "a stage still holding leads must say so, not report success");
});

// ── Nested dialogs ─────────────────────────────────────────────────────────

test("ConfirmDelete owns its dialog and does not close an enclosing modal too", () => {
  const code = src("src/components/ConfirmDelete.tsx");
  assert.match(code, /closeModalOnSuccess=\{false\}/, "it closes its own dialog via onSaved");
  assert.match(code, /onSaved=\{\(\) => setOpen\(false\)\}/, "and must still close itself");
});
