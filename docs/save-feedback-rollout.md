# Save-feedback (toast) rollout — parked 2026-07-30

Every save in the app should say whether it worked. This document records where
the rollout stopped, how to resume it, and the traps that cost time.

**Status: parked after batch 8. 209 forms across 94 files remain.**
23 of 75 action modules converted.

---

## Why this exists

"I changed the modules in the tenant console and hit save, but didn't know if
anything happened." That was literally true of a whole class of controls — some
fired their action as a floating promise and discarded both the result and any
rejection.

The conversion is not cosmetic. Every batch so far has surfaced real defects:
silent no-ops, discarded uploads, committed writes reported as failures,
authorisation-ordering oracles, and races that told two people contradictory
things. Attaching a success toast to an action forces the question "is this
actually true?" — and repeatedly the answer was no.

---

## The two halves

### 1. Server actions return results; they do not throw at the user

Next replaces thrown error messages with opaque digests in production, so a
thrown `Error` reaches the person as "Something went wrong". Expected refusals
must be **returned as values**.

```ts
// src/lib/actionResult.ts
export async function myAction(formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requirePermission("thing.manage");   // authorise FIRST
    if (!name) refuse("Give it a name.");                   // expected → refusal
    // …
    return { redirectTo: `/things/${id}` };                 // navigate on success
  });
}
```

- `refuse(msg)` / `throw new ActionRefusal(msg)` → `{ error }`, toasted red.
- Returning nothing → `{}`, toasted with the form's `success` message, green.
- `redirectTo` is **returned, never** `redirect()`. A thrown redirect is
  indistinguishable from the ones auth guards throw, which is how "every
  redirect reported success" happened (#253).

### 2. Forms use `SaveForm` / `SaveButton`

`src/components/SaveForm.tsx` submits via `onSubmit` (not the `action` prop) so
a failure keeps what was typed. It handles pending state, toasts, reset,
password clearing, modal closing and `redirectTo`.

```tsx
<SaveForm action={saveThing} success="Thing saved" resetOnSuccess={false}>
  <input name="name" className="input" />
  <SaveButton className="btn-primary">Save</SaveButton>
</SaveForm>
```

`resetOnSuccess` defaults **on** (create forms). Turn it **off** for edit forms
so they keep showing what was saved. Passwords are cleared either way.

---

## How a batch is done

1. **Pick a closure, not a page.** Group by the action modules a page imports —
   converting a module forces every page that imports it. `git grep -l
   "@/app/actions/<module>"` gives the closure. Do the whole thing or the build
   breaks.
2. **Convert the actions.** Wrap in `asActionResult`, turn `throw new Error`
   into refusals, turn `redirect(...)` into `return { redirectTo }`.
3. **Decide every silent `return;`.** The wrap scripts flag them. Each is either
   a refusal or an honest success message — never left silent, because a success
   toast on a no-op is a lie.
4. **Convert the forms.** `tsc --noEmit` lists exactly which files need it: the
   action's new return type stops assigning to `=> Promise<void>`.
5. **Run the audit:** `npx tsx --test tests/saveFeedback.test.ts`.
6. **Drive it in a browser.** Non-negotiable — see "traps" below.
7. **One PR per batch.** Do not merge without review.

### The audit test is the safety net

`tests/saveFeedback.test.ts` discovers converted modules **from disk** (an
earlier version had a hand-written list and two modules escaped it twice). It
enforces: no `throw new Error` in converted modules; no bare early `return;`
inside a wrapped action; authorisation precedes every refusal; no bare
`=> void` action props; secrets cleared outside the reset guard; no
`toast.success` in a catch; uploads refuse empty/all-invalid selections.

---

## Traps that cost real time

- **`tsc` is the worklist, but it has one hole.** A value-returning function
  satisfies a `=> void` prop signature, so a converted action assigned to
  `(fd: FormData) => void` compiles and silently drops the result. The audit
  test now bans bare `=> void` action props. Retype props to
  `(fd: FormData) => Promise<ActionResult | void>`.
- **A form cannot live inside a `<label>`.** `<form>` is flow content, `<label>`
  takes phrasing content. Invalid nesting; the parser may reshape it.
- **`requestSubmit()` works fine with `SaveForm`** — but React's value tracker
  swallows `select.value = x`. Use the native setter in test drivers.
- **Duplicate `name` attributes across a page.** `/cases/[id]` has TWO
  `select[name="status"]` (the composer's "send & set to" and the sidebar's
  auto-submit). A driver that grabs the first one tests the wrong control — this
  produced two false failures before I noticed.
- **Compare-and-set against what the PAGE showed**, not a value re-read in the
  same request. A fresh re-read is current by construction and checks almost
  nothing. Pass the rendered value as a hidden field (see `expectedStatus` in
  `replyToTicket`).
- **Post-commit bookkeeping must not fail the save.** Event/notification writes
  that run after a transaction commits are best-effort with the failure logged
  (`addStockEvent`, helpdesk's `notifyCustomer`/`logEvent`). Otherwise a
  committed write is reported as a failure and the retry duplicates it.
- **Dev is slow.** Cold-compiling a route takes 10–45s; toast polls need ~30s
  and login needs a URL-change wait, not a fixed sleep.

---

## What is left

209 forms / 94 files. Suggested batches, largest coherent closures first:

| forms | closure | files |
|---|---|---|
| 12 | `documents + studio` | `document-studio`, `settings/documents` |
| 11 | `testDrives` | `test-drives` ×3 |
| 9 | `documents` | `documents`, `settings/documents/t/[id]`, `DocumentsPanel`, `RepoRow` |
| 8 | `journeyRuns + journeys` | `journeys/page.tsx` |
| 8 | `marketingSurveys` | `marketing/surveys` ×2 |
| 15 | *(no action import)* | login, layouts, filter/search forms — **check individually; many are GET filters that need no toast** |

Then a long tail of ~80 files. Regenerate the grouping any time with a script
that counts `<form` per file and maps `@/app/actions/(\w+)` imports.

Pending modules: `activities, automations, backups, bot, campaigns,
communications, company, competitors, customerCases, customFields, doclibrary,
documents, fleets, flow, import, journeyRuns, journeys, library,
marketingCampaign*, marketingContent, marketingSurveys, merge, messenger,
modules, parts, passkeys, platformUsage, portal, portalExpansion, products,
push, quickCreate, recordSigning, runbook, sessions, signflow, signhub,
signing, studio, surveyDistributions, surveyFollowUps, surveys, targets,
tenantCredentials, testDrives, timelinePins, trash, vehicles, warranty,
whatsapp`.

---

## Batches merged

| PR | batch | notable defects found |
|---|---|---|
| #251/#252 | shared component, settings, pipelines | credentials left in the DOM after save |
| #253 | CRM records | every redirect reported as success |
| #254 | operations | selected paperwork discarded; referral status oracle |
| #255 | job cards, document builder | photo uploads false success; `CameraCapture` discarded errors |
| #256 | stock | `nextStockNumber` int overflow — intake 500ed on the 3rd unit of a year; stock-number race; committed writes reported as failures |
| #257 | access, portal, workshop | fire-and-forget module/role toggles; non-atomic governance audits; raceable last-administrator checks |
| #258 | help desk | reply overwrote concurrent status changes; reply body lost on failure |

---

## Also outstanding (not part of this rollout)

- **PR #259** — cron database warm-up. In review.
- **Preview-database isolation** — needs dashboard access: GitHub secrets
  `NEON_API_KEY` and `NEON_PROJECT_ID`; Vercel Preview `DATABASE_URL` /
  `DATABASE_URL_UNPOOLED` pointed at a preview branch; then
  `PREVIEW_DB_ISOLATED=1` **last**. Until then the guard in
  `scripts/apply-migrations.mjs` is the only thing stopping preview deploys
  migrating production — the failure that broke every settings save for 1.5 days.
- **Error push notifications are off** for `tenant_denago_cpt` only
  (`PUSH_DISABLED_KINDS=system_error`). It is a per-tenant setting: a second
  tenant would start paging again. Errors still land in Settings → System Log.
