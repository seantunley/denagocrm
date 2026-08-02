import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** Source with comments stripped — a naive regex otherwise matches the very
 *  comment that documents the fix. */
const shipped = (rel: string) =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * Creating a quote landed you in one of TWO different UIs depending on which
 * button you pressed: the lead page sent you to the read-only record page,
 * while the quotes list and the lead's own "next step" prompt opened the draft
 * editor. Same intent, same lead, different experience.
 */
test("every route to a NEW quote opens the draft editor", () => {
  const code = src("src/app/actions/quotes.ts");
  const creators = ["createQuoteFromLead", "createQuoteForContact"];
  for (const name of creators) {
    const at = code.indexOf(`export async function ${name}(`);
    assert.ok(at > 0, `${name} must exist`);
    // Read to the end of the function (next top-level export).
    const nextAt = code.indexOf("\nexport ", at + 1);
    const body = code.slice(at, nextAt > 0 ? nextAt : undefined);
    assert.match(
      body,
      /\/quotes\?edit=/,
      `${name} must open the editor, not the read-only record page`,
    );
    assert.doesNotMatch(
      body,
      /["'`]\/quotes\/\$\{quote\.id\}/,
      `${name} must not send a NEW quote to the record page`,
    );
  }
});

test("the split entry point is gone, not merely bypassed", () => {
  const code = src("src/app/actions/quotes.ts");
  assert.ok(
    !code.includes("createQuoteFromLeadInEditor"),
    "the second lead-to-quote creator must be removed, or the split can come back",
  );
  // …and nothing may still import it.
  for (const file of ["src/components/proactive/NextStep.tsx", "src/app/(app)/leads/[id]/page.tsx"]) {
    assert.ok(
      !src(file).includes("createQuoteFromLeadInEditor"),
      `${file} still references the removed creator`,
    );
  }
});

/**
 * Deleting a quote is one behaviour with three doorways — the list, the record
 * page and now the editor. The rules that matter are all server-side in
 * deleteQuote(): quotes.delete on THAT quote, a reason on the record, voiding a
 * live signing request, reopening the lead behind an accepted quote. A second
 * doorway that reimplemented any of it would be the one that drifts.
 */
test("every doorway to deleting a quote goes through the same action and the same dialog", () => {
  const surfaces = [
    "src/app/(app)/quotes/[id]/page.tsx",
    "src/app/(app)/quotes/page.tsx",
    "src/components/quotes/QuoteEditorDialog.tsx",
  ];
  for (const rel of surfaces) {
    const code = shipped(rel);
    assert.match(code, /<ConfirmDelete/, `${rel} must use the shared confirmation, not its own`);
    assert.match(
      code,
      /action=\{deleteQuote\.bind\(null, (quote|savedQuote)\.id\)\}/,
      `${rel} must bind the shared action — the rules live inside it`,
    );
  }
});

test("the reason is required of the caller, and recorded by the action", () => {
  // A trashed quote with no reason is unauditable, and Trash shows the reason
  // next to the record. One `required` field backs all three doorways.
  const dialog = shipped("src/components/ConfirmDelete.tsx");
  assert.match(dialog, /name="reason"[^>]*required|required[^>]*name="reason"/, "the reason field must be required");

  const action = shipped("src/app/actions/quotes.ts");
  const start = action.indexOf("export async function deleteQuote(");
  assert.ok(start > 0, "deleteQuote must exist");
  const body = action.slice(start, action.indexOf("\nexport ", start + 1));
  assert.match(body, /requireQuoteAccess\(id, "quotes\.delete"\)/, "permission on THIS quote");
  assert.match(body, /deleteReason: reason/, "the reason must reach the record");
  assert.match(body, /status: "voided"/, "a live signing request must not survive the quote");
  assert.match(body, /reopenLeadInTx/, "an accepted quote's lead must reopen");
});

test("deleting from the editor dismisses the editor, without asking about unsaved edits", () => {
  // Two ways to get this wrong: leave the dialog open on a quote that no longer
  // exists, or route the close through the discard prompt — which would ask
  // whether to save changes to something already in the Trash.
  const code = shipped("src/components/quotes/QuoteEditorDialog.tsx");
  const at = code.indexOf("<ConfirmDelete");
  assert.ok(at > 0, "the editor must offer delete");
  const block = code.slice(at, code.indexOf("/>", at));
  assert.match(block, /onDeleted=\{\(\) => onOpenChange\(false\)\}/, "it must close, and not via requestOpenChange");
  assert.match(block, /contentClassName="z-\[110\]"/, "nested in a dialog, the confirmation must stack above it");
});

test("all three doorways grey the delete out when the role can't use it", () => {
  // The button used to be offered to everyone and refused on click — after the
  // reason had been typed. Greying it out is a HINT: deleteQuote() still runs
  // the same check, so a client that ignores this gets refused anyway.
  for (const rel of [
    "src/app/(app)/quotes/[id]/page.tsx",
    "src/app/(app)/quotes/page.tsx",
    "src/components/quotes/QuoteEditorDialog.tsx",
  ]) {
    const code = shipped(rel);
    assert.match(code, /disabled=\{!canDelete\}/, `${rel} must grey the control out`);
    assert.match(code, /disabledReason=/, `${rel} must say why, not just go grey`);
  }
  const confirm = shipped("src/components/ConfirmDelete.tsx");
  assert.match(confirm, /disabled=\{disabled\}/, "the trigger must actually be disabled, not merely faded");
  assert.match(confirm, /opacity-40/, "…and look it");
});

test("the greying-out asks the same question the action enforces", () => {
  // A hint that checked something LOOSER than the action would offer a button
  // that fails; something TIGHTER would hide a delete the user is entitled to.
  const action = shipped("src/app/actions/quotes.ts");
  const start = action.indexOf("export async function canDeleteQuote(");
  assert.ok(start > 0, "the capability check must exist");
  const body = action.slice(start, action.indexOf("\nexport ", start + 1));
  assert.match(body, /hasPermission\(user, "quotes\.delete"\)/, "same permission as deleteQuote");
  assert.match(body, /canAccessQuote\(user, id\)/, "…and access to that same quote");
  assert.match(body, /if \(!user\) return false;/, "no session, no button");
});

test("the delete control defaults to unavailable until the answer arrives", () => {
  // The editor asks the server, so there is a gap. Starting enabled and greying
  // out a moment later invites exactly the click it exists to prevent.
  const code = shipped("src/components/quotes/QuoteEditorDialog.tsx");
  assert.match(
    code,
    /const canDelete = signingFetch\?\.quoteId === signingQuoteId && signingFetch\.canDelete/,
    "an unanswered or stale fetch must not read as permitted",
  );
  const failurePath = code.slice(code.indexOf(".catch("), code.indexOf(".catch(") + 220);
  assert.match(failurePath, /canDelete: false/, "a failed fetch must not read as permitted either");
});

test("the editor only offers delete once there is something to delete", () => {
  const code = shipped("src/components/quotes/QuoteEditorDialog.tsx");
  const at = code.indexOf("<ConfirmDelete");
  const before = code.slice(Math.max(0, at - 200), at);
  assert.match(before, /savedQuote && \(/, "an unsaved draft has no record to trash");
});

/**
 * Retiring the record page means the editor has to be able to do everything
 * that page could. These pin the moves that lived ONLY there, so a later change
 * cannot quietly strand a quote in the editor again.
 */
test("the editor can carry a quote through its whole lifecycle", () => {
  const code = shipped("src/components/quotes/QuoteEditorDialog.tsx");
  for (const [call, what] of [
    ['setQuoteStatus(savedQuote.id, "accepted")', "accepting a quote — this is what wins the lead"],
    ['setQuoteStatus(savedQuote.id, "declined")', "declining a quote"],
    ['setQuoteStatus(savedQuote.id, "draft")', "reopening a decided quote"],
    ["createQuoteRevision(savedQuote.id)", "revising a quote the customer has seen"],
  ] as const) {
    assert.ok(code.includes(call), `the editor has no way of ${what}`);
  }
  // The same gates the record page applied, so the editor can't offer a
  // transition the server will refuse.
  assert.match(code, /const canDecide = !permanentlyReadOnly && currentStatus === "sent"/);
  assert.match(code, /const canReopen = !permanentlyReadOnly && \(currentStatus === "accepted" \|\| currentStatus === "declined"\)/);
  assert.match(code, /const canRevise = !permanentlyReadOnly && \(currentStatus === "sent" \|\| currentStatus === "declined"\)/);
  assert.match(code, /signing\?\.signedAt \|\| record\?\.supersededAt/, "signed and superseded are permanently read-only");
});

test("a refused transition says why instead of appearing to do nothing", () => {
  // setQuoteStatus returns refusals as values — "out for signature, void the
  // request first". Dropping the result would make a blocked click look inert.
  const code = shipped("src/components/quotes/QuoteEditorDialog.tsx");
  const fn = code.slice(code.indexOf("function runLifecycle("), code.indexOf("function save("));
  assert.match(fn, /if \(result\?\.error\)/, "the refusal must be read");
  assert.match(fn, /setError\(result\.error\)/, "…and shown in the banner");
  // The buttons sit in the HEADER, so a click can come from Preview or Versions
  // — neither of which renders the banner. A toast is the only surface that
  // reaches all four tabs.
  assert.match(fn, /toast\.error\(result\.error\)/, "…and from tabs that have no banner");
});

test("the lifecycle actions are reachable from every tab", () => {
  // They were one tab deep, inside Send, and read as missing — which is the
  // hunting across screens this whole consolidation exists to remove.
  const code = shipped("src/components/quotes/QuoteEditorDialog.tsx");
  const header = code.slice(code.indexOf("<DialogHeader"), code.indexOf("<Tabs "));
  for (const label of ["Accepted", "Declined", "Back to draft", "Revise"]) {
    assert.ok(header.includes(`>${label}</Button>`), `"${label}" must be in the header, not inside a tab`);
  }
  const sendTab = code.slice(code.indexOf('<TabsContent value="send"'));
  assert.doesNotMatch(sendTab, /Record the outcome/, "and must not be duplicated back into the Send tab");
});

test("a revision opens in the editor rather than navigating to a page", () => {
  // createQuoteRevision returns a NEW quote id. Pushing /quotes?edit=<id> from
  // inside /quotes only changes the URL — the provider reads that param once,
  // on mount — so the id is handed to the provider instead.
  const action = shipped("src/app/actions/quotes.ts");
  const body = action.slice(action.indexOf("export async function createQuoteRevision("));
  assert.match(body.slice(0, body.indexOf("\nexport ")), /redirectTo: `\/quotes\?edit=\$\{revision\.id\}`/);

  const code = shipped("src/components/quotes/QuoteEditorDialog.tsx");
  assert.match(code, /onOpenQuote\(revisionId\)/, "the provider must be told, not the router");
  assert.match(
    code,
    /key=\{selection\.quoteId \?\? "new"\}/,
    "and the dialog must remount, or the new record renders against the old draft",
  );
});

test("the editor can open a quote the page never rendered", () => {
  // A revision's id does not exist when the list renders, and the list is capped
  // at 200 — so `records.find()` returned null and the editor opened BLANK,
  // because a missing record is indistinguishable from "new quote".
  const code = shipped("src/components/quotes/QuoteEditorDialog.tsx");
  assert.match(code, /quoteEditorRecord\(quoteId\)/, "a quote outside the list must be fetched");
  assert.match(
    code,
    /\{selection && !awaitingRecord && \(/,
    "and the dialog must not mount until it arrives — the draft is built once, at mount",
  );
  assert.match(code, /const awaitingRecord = Boolean\(selection\?\.quoteId\) && !record/);
});

test("version history opens a version instead of navigating under the dialog", () => {
  // "Open" was a Link to /quotes/<id>. From inside an open modal that changed
  // the route UNDERNEATH the overlay — the dialog stayed put, so the button
  // did nothing you could see.
  const code = shipped("src/components/quotes/QuoteEditorDialog.tsx");
  assert.match(code, /onClick=\{\(\) => requestOpenVersion\(version\.id\)\}/, "it must swap the editor over");
  const fn = code.slice(code.indexOf("function requestOpenVersion("), code.indexOf("function discardAndClose("));
  assert.match(fn, /if \(dirty && !isPending\)/, "unsaved edits must not vanish on a version switch");
  assert.match(fn, /setPendingVersionId\(quoteId\)/, "…the same prompt that guards closing");
  // And dismissing the prompt must forget the destination, or a later Close
  // would switch versions instead of closing.
  assert.match(code, /if \(!next\) setPendingVersionId\(null\)/);
});

test("the row rewrite does not add round trips inside the transaction", () => {
  // Reading the prior rows as two separate queries inside the interactive
  // transaction pushed it past Prisma's 5s budget on a high-latency database:
  // the save failed with P2028 rather than committing. They ride along with the
  // editability check, which was already being made.
  const code = shipped("src/app/actions/quotes.ts");
  // Both markers appear more than once in the file — bound the end search by the
  // start, or the slice runs backwards and silently matches nothing.
  const start = code.indexOf("const result = await basePrisma.$transaction(");
  assert.ok(start > 0, "saveQuoteDraft's transaction must exist");
  const tx = code.slice(start, code.indexOf("const number = await nextQuoteNumber(tx)", start));
  assert.ok(tx.length > 200, "the slice must actually contain the transaction body");
  assert.match(tx, /include: \{ items: true, fees: true \}/, "the prior rows must ride along with a query already being made");
  assert.doesNotMatch(tx, /tx\.quoteItem\.findMany|tx\.quoteFee\.findMany/, "no extra reads inside the transaction");
  assert.match(tx, /priorById\(existing\.items\)/, "carry-forward still happens");
  assert.match(tx, /priorById\(existing\.fees\)/);
});

test("one builder makes the editor's record, wherever it is loaded", () => {
  // Two copies would drift, and the difference would show up as fields that
  // work from the list and are empty from a revision or a deep link.
  const list = shipped("src/app/(app)/quotes/page.tsx");
  const action = shipped("src/app/actions/quotes.ts");
  for (const [name, code] of [["the quotes list", list], ["quoteEditorRecord()", action]] as const) {
    assert.match(code, /buildQuoteEditorRecord\(/, `${name} must use the shared builder`);
    assert.match(code, /quoteVersionIndex\(/, `${name} must use the shared version index`);
    assert.match(code, /QUOTE_EDITOR_INCLUDE/, `${name} must load the same columns`);
  }
  // Read-only, and gated — it feeds a dialog, so it returns null rather than
  // redirecting the way a page guard would.
  const body = action.slice(action.indexOf("export async function quoteEditorRecord("));
  const fn = body.slice(0, body.indexOf("\nexport "));
  assert.match(fn, /hasAnyPermission\(user, "quotes\.view_all", "quotes\.view_owned"\)/);
  assert.match(fn, /canAccessQuote\(user, id\)/);
  assert.match(fn, /if \(!quote \|\| quote\.deletedAt\) return null/);
  assert.doesNotMatch(fn, /requireQuoteReadAccess|redirect\(/, "a dialog's data fetch must not redirect");
});

test("custom fields exist in the editor, through the same form as everywhere else", () => {
  const code = shipped("src/components/quotes/QuoteEditorDialog.tsx");
  assert.match(code, /<CustomFieldsForm/, "the workspace's own quote fields must be reachable");
  assert.match(code, /saveCustomFieldValues\.bind\(null, "quote", savedQuote\.id\)/, "saved by the shared action");
  assert.match(code, /recordCustomFields\("quote", signingQuoteId\)/, "and read for this quote");
  // One form, both surfaces — the card is a server component the dialog can't render.
  assert.match(shipped("src/components/custom-fields/CustomFieldsCard.tsx"), /<CustomFieldsForm/);
});

test("a custom-field refusal reaches the person, and doesn't take the draft with it", () => {
  // These threw plain Errors: in production Next replaces the message with an
  // opaque digest, and the throw hit the error boundary — survivable on a page,
  // fatal to an editor dialog holding unsaved work.
  const code = shipped("src/app/actions/customFields.ts");
  assert.match(code, /return asActionResult\(/, "refusals must travel as values");
  assert.match(code, /refuse\(errors\.join\(" "\)\)/, "validation messages must be shown, not digested");
  assert.match(code, /refuse\("This quote is locked/, "so must the lock refusal");
  assert.doesNotMatch(code, /throw new Error\(errors/, "the thrown form is what made it invisible");
});

test("saving from the editor stops resetting the columns it never shows", () => {
  // saveQuoteDraft replaces every row. The payload carries no kind, costCents,
  // optional, selected or per-line VAT — so each save reverted them to schema
  // defaults: margin's cost basis zeroed, declined optional add-ons silently
  // re-included. Rows are matched by id and the values carried across.
  const code = shipped("src/app/actions/quotes.ts");
  const at = code.indexOf("const itemRows = itemRowsFor(normalizedItems, priorById(existing.items))");
  assert.ok(at > 0, "the previous rows must be read before they are deleted");
  assert.ok(at < code.indexOf("tx.quoteItem.deleteMany"), "…BEFORE, or there is nothing left to read");
  assert.match(code, /id: z\.string\(\)\.trim\(\)\.min\(1\)\.nullable\(\)\.optional\(\)/, "the payload must identify the row");

  // The inheritance itself, and the id-reuse that makes it work on the SECOND
  // save too, live in quoteRows.ts and are exercised behaviourally there.
  const rows = shipped("src/lib/quoteRows.ts");
  for (const field of ["kind", "costCents", "optional", "selected"]) {
    assert.match(rows, new RegExp(`${field}: previous\\?\\.${field}`), `${field} must be carried across`);
  }
  assert.match(rows, /taxRatePct: taxRatePct \?\? previous\?\.taxRatePct \?\? 15/);
  assert.match(rows, /\.\.\.\(previous \? \{ id: previous\.id \} : \{\}\)/, "a surviving row must keep its id");
});

test("a client-supplied row id never reaches a primary key", () => {
  // The id exists to look up the PREVIOUS row. Spreading it into create() on a
  // new quote would let the caller choose the record's id.
  const code = shipped("src/app/actions/quotes.ts");
  const create = code.slice(code.indexOf("return tx.quote.create({"));
  assert.doesNotMatch(create.slice(0, create.indexOf("});")), /\.\.\.item|\.\.\.fee/, "build the row explicitly, don't spread the payload");
});

test("the editor shows margin only when there is a cost to compare against", () => {
  const code = shipped("src/components/quotes/QuoteEditorDialog.tsx");
  assert.match(code, /hasCost: p\.costCents > 0/, "a zero-cost quote would otherwise report 100% margin");
  assert.match(code, /calculated\.hasCost && <div/, "…and the row is gated on it");
  assert.match(code, /costCents: line\.costCents/, "the cost has to reach the pricing call");
});

test("the editor is not a dead end for the records around the quote", () => {
  const code = shipped("src/components/quotes/QuoteEditorDialog.tsx");
  assert.match(code, /href=\{`\/contacts\/\$\{record\.contactId\}`\}/, "the customer must be reachable");
  assert.match(code, /href=\{`\/leads\/\$\{record\.leadId\}`\}/, "so must the lead");
  assert.match(code, /Open Q-\{record\.supersededByNumber\} instead/, "a superseded version must point at its successor");
  assert.match(code, /record\?\.changeRequestedAt && !record\.supersededAt/, "a change request must be visible");
});

test("the next-step prompt reports the real outcome, not an optimistic one", () => {
  // It used to toast "Creating a quote…" as a SUCCESS before the action ran, so
  // a failure still read as though the quote had been created.
  const code = src("src/components/proactive/NextStep.tsx");
  const at = code.indexOf("createQuoteFromLead(leadId)");
  assert.ok(at > 0, "the prompt must still create the quote");
  const around = code.slice(Math.max(0, at - 400), at + 400);
  assert.match(around, /result\?\.error/, "a refusal must be surfaced");
  assert.match(around, /router\.push\(result\.redirectTo\)/, "it must follow the returned editor link");
  assert.doesNotMatch(
    around,
    /toast\.success\([^)]*\);\s*\n\s*(await\s+)?createQuoteFromLead/,
    "success must not be announced before the action runs",
  );
});
