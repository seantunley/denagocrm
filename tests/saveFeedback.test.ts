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
// A THROWN redirect is not evidence of a save. The auth guards redirect too — an
// expired session to /login, a revoked permission to /, denied record access to
// /leads — so inferring success from one meant "Lead saved" could appear when the
// mutation never ran. Success navigation must be explicit.
test("SaveForm: never infers success from a thrown redirect", () => {
  const code = src("src/components/SaveForm.tsx");
  const catchBlock = code.slice(code.indexOf("} catch (error) {"));
  assert.doesNotMatch(
    catchBlock,
    /toast\.success/,
    "nothing in the catch may report a save — a guard redirect lands there too",
  );
  assert.match(
    catchBlock,
    /unstable_rethrow\(error\)/,
    "framework signals must be rethrown via Next's own predicate, not a digest-string match",
  );
  assert.doesNotMatch(
    code,
    /NEXT_REDIRECT|NEXT_NOT_FOUND/,
    "hand-rolled digest matchers go stale between Next versions",
  );
});

test("SaveForm: navigates only when the action returns redirectTo", () => {
  const code = src("src/components/SaveForm.tsx");
  assert.match(code, /"redirectTo" in result/, "the destination must come from the action's result");
  assert.match(code, /if \(redirectTo\) router\.push/, "and drive a client-side navigation");
});

// The actions that used to redirect() on success must now RETURN the destination,
// so the redirect can no longer be confused with a guard's.
for (const file of ["src/app/actions/leads.ts", "src/app/actions/contacts.ts", "src/app/actions/quotes.ts"]) {
  test(`${file}: success paths return redirectTo instead of throwing a redirect`, () => {
    const code = src(file);
    const wrapped = code.split("return asActionResult(async () => {").slice(1);
    for (const block of wrapped) {
      const body = block.split("\n  });")[0];
      assert.doesNotMatch(
        body,
        /^\s*redirect\(/m,
        "a thrown redirect inside a converted action is indistinguishable from a guard's",
      );
    }
    assert.match(code, /redirectTo:/, "and the destination must be returned");
  });
}

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
// EVERY module with a converted action, not a sample. The first version of this
// test listed four, and setQuoteStatus's silent early return slipped through in
// quotes.ts precisely because it was not on the list.
for (const file of [
  "src/app/actions/settings.ts",
  "src/app/actions/pipelines.ts",
  "src/app/actions/emails.ts",
  "src/app/actions/ai.ts",
  "src/app/actions/stock.ts",
  "src/app/actions/leads.ts",
  "src/app/actions/contacts.ts",
  "src/app/actions/quotes.ts",
  "src/app/actions/cpq.ts",
  "src/app/actions/views.ts",
  "src/app/actions/privacy.ts",
  "src/app/actions/fulfilment.ts",
  "src/app/actions/referrals.ts",
  "src/app/actions/tenants.ts",
  "src/app/actions/platformAdmins.ts",
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

// ── Selected files must never be silently discarded ────────────────────────

// The file is OPTIONAL on scheduleDelivery and markDelivered, but an oversized
// one was skipped while the stage change went ahead — so the delivery was
// scheduled, success was reported, the form disappeared, and the paperwork the
// user picked never arrived.
test("fulfilment: an oversized SELECTED file refuses before the stage changes", () => {
  const code = src("src/app/actions/fulfilment.ts");
  assert.doesNotMatch(
    code,
    /if \(file && file\.size <= MAX_FILE\)/,
    "skipping an oversized file while proceeding hides the loss",
  );
  const refusals = code.match(/if \(file && file\.size > MAX_FILE\) refuse\(/g) ?? [];
  assert.ok(refusals.length >= 2, "both optional-file stages must refuse an oversized selection");
});

test("uploadDeliveryPhotos: refuses an empty or wholly invalid selection", () => {
  const code = src("src/app/actions/fulfilment.ts");
  const fn = code.slice(code.indexOf("export async function uploadDeliveryPhotos"));
  assert.match(fn, /files\.length === 0\) refuse\(/, "nothing selected is not a successful upload");
  assert.match(fn, /accepted\.length === 0\)\s*\{?\s*refuse\(/, "all-invalid is not a successful upload");
  assert.match(fn, /skipped > 0/, "a partial upload must say how many were dropped");
});

// ── Authorisation before disclosure ────────────────────────────────────────

// Specific refusals are useful, but specificity BEFORE an authorisation check
// turns the action into an oracle: an unauthorised session could probe ids and
// read back whether each referral exists and what state it is in.
test("redeemReferral: authorises before any state-revealing refusal", () => {
  const code = src("src/app/actions/referrals.ts");
  const gate = code.indexOf('requirePermission("referrals.manage")');
  const existence = code.indexOf('refuse("That referral no longer exists.")');
  const status = code.indexOf("refuse(`That referral is already");
  const scoped = code.indexOf("requireContactAccess(");
  assert.ok(gate > 0, "the capability must be checked");
  assert.ok(gate < existence, "existence must not be revealed before the capability check");
  assert.ok(scoped < status, "status must not be revealed before the contact-scoped check");
});
