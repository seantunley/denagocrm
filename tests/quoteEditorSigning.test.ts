import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** Source with comments stripped — a naive regex otherwise matches the very
 *  comment that documents the fix. */
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Body of a top-level exported function, up to the next one. */
function actionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} not found — was it renamed?`);
  const rest = source.slice(start + 1);
  const next = rest.indexOf("\nexport async function ");
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Sending a quote used to be two screens. You priced it in the editor, then the
 * Send tab told you to "generate and manage the secure signing link from the
 * full quote record" — a different page, reached by leaving a half-finished
 * quote behind. The signature card now lives in the tab whose job is sending.
 */

test("the Send tab signs the quote instead of pointing at another screen", () => {
  const code = read("src/components/quotes/QuoteEditorDialog.tsx");
  assert.match(code, /<SigningBlock/, "the signature card must be embedded in the editor");
  assert.doesNotMatch(
    code,
    /Generate and manage the secure signing link from the full quote record/,
    "the hand-off to another screen is what this replaced",
  );
});

test("the embedded card refetches — a route refresh cannot reach inside a dialog", () => {
  // SigningBlock's props come from a server component on the record page, so
  // router.refresh() is enough there. In the editor they come from an on-demand
  // fetch, and without a callback the card would still show the countersign pad
  // after you had already countersigned.
  const code = read("src/components/quotes/QuoteEditorDialog.tsx");
  assert.match(code, /onChanged=\{reloadSigning\}/, "the editor must be told when signing state changes");

  const card = shipped("src/components/SigningBlock.tsx");
  assert.equal(
    (card.match(/router\.refresh\(\)/g) ?? []).length,
    1,
    "every refresh must route through the wrapper that also notifies the embedder",
  );
  assert.match(card, /onChanged\?\.\(\)/, "the card never notifies an embedder, so an embedded card goes stale");
  // The signature pad is a child of that card and has no router of its own —
  // it reports upward and lets the card decide what to re-read.
  assert.match(shipped("src/components/signing/SignatureCapture.tsx"), /onSaved\(\)/);
});

test("a live signing request makes the editor read-only", () => {
  // record.lockedReason is computed when the LIST page renders, so it knows
  // nothing about a request started from this dialog thirty seconds ago. The
  // fetched state does, and it has to feed the same gate.
  const code = shipped("src/components/quotes/QuoteEditorDialog.tsx");
  assert.match(
    code,
    /const editable = [^;]*!signing\?\.locked/,
    "the edit gate must account for a request started from inside the editor",
  );
  assert.match(
    code,
    /const lockedReason = signing\?\.locked/,
    "…and say so, rather than blaming a revision that isn't the reason",
  );
});

test("`locked` is decided on the server, where the lifecycle rules live", () => {
  // isRequestClosed() is server-only, so a client dialog cannot work out
  // whether a request is still open. Shipping the answer, not the inputs, is
  // what stops the editor inventing a second definition of "locked".
  assert.match(read("src/lib/signing/status.ts"), /^import "server-only";/m);
  const body = actionBody(shipped("src/app/actions/recordSigning.ts"), "quoteSigningView");
  assert.match(body, /locked: isLockedForSigning\(state\)/);
  assert.match(body, /quote\.signToken/, "the historic signToken link locks the record too");
});

test("reading signing state is gated as tightly as starting a request", () => {
  // The payload carries every recipient's secure link — a token whose holder can
  // sign. A read gate looser than the write gate would hand those links to
  // anyone who could open the quote editor.
  const body = actionBody(shipped("src/app/actions/recordSigning.ts"), "quoteSigningView");
  assert.match(body, /hasPermission\(user, "quotes\.change_status"\)/, "same permission as startRecordSigning");
  assert.match(body, /canAccessQuote\(user, id\)/, "…and access to that specific quote");

  const gate = body.search(/canAccessQuote\(user, id\)/);
  const load = body.search(/prisma\.quote\.findUnique/);
  assert.notEqual(load, -1, "it must read the quote — has it been gutted?");
  assert.ok(gate < load, `the access check must precede the read (gate ${gate}, read ${load})`);
});

test("the read gate returns nothing rather than redirecting", () => {
  // requireQuoteAccess() calls redirect(), which throws NEXT_REDIRECT. Thrown
  // out of a panel's data fetch that is a crash, not a refusal.
  const body = actionBody(shipped("src/app/actions/recordSigning.ts"), "quoteSigningView");
  assert.doesNotMatch(body, /requireQuoteAccess|requirePermission\(/, "this is a read for a panel, not a page");
  assert.match(body, /if \(!user\) return null;/);
  assert.match(body, /return null;/);
});

test("a quote that cannot be signed yields no card", () => {
  // findUnique is not soft-delete filtered, and a superseded version is not
  // signable — the record page hides the card for it and so must the editor.
  const body = actionBody(shipped("src/app/actions/recordSigning.ts"), "quoteSigningView");
  assert.match(body, /!quote \|\| quote\.deletedAt \|\| quote\.supersededAt/);
});

test("the signature pad stores a signature and nothing else", () => {
  // It used to draw a signature AND stamp it onto the quote in one action,
  // writing Quote.dealerSigned* — columns the envelope the customer received
  // knew nothing about. That is what made countersigning happen twice.
  const pad = shipped("src/components/signing/SignatureCapture.tsx");
  assert.match(pad, /saveMySignature/, "the pad's only job is storing the image");
  assert.doesNotMatch(pad, /quoteId|recordSigning/, "it must not know about the record being signed");
  assert.match(pad, /src="\/api\/me\/signature"/, "and it shows what it has stored");
  assert.match(pad, /onError=\{\(\) => setPreviewFailed\(true\)\}/, "a ref whose bytes are gone must not leave a broken frame");
});

/**
 * There were two countersignature systems. "Sign as Denago" wrote three columns
 * on the quote row, read only by the Print/PDF view. "Send for signing" then
 * built an envelope that had never heard of those columns, invented a fresh
 * Denago signer, and opened its signing surface — so you signed twice, in two
 * different places, onto two different documents, and the second one could not
 * offer the signature you had just used.
 */

test("only one thing countersigns a quote", () => {
  const actions = shipped("src/app/actions/signing.ts");
  assert.doesNotMatch(actions, /export async function signAsDealer/, "the quote-level countersignature is retired");
  assert.doesNotMatch(actions, /dealerSignedAt/, "…including the columns it wrote behind the envelope's back");

  // Those columns still feed the Print/PDF view, so the surviving path keeps
  // them in step rather than leaving the printed quote unsigned.
  const countersign = shipped("src/lib/signing/countersign.ts");
  // Asserts that the print columns are still WRITTEN, not the exact expression
  // that supplies the timestamp. The countersign now stamps the same `filledAt`
  // used by the rest of its transaction, so the printed quote and the signature
  // evidence agree on when it happened — an improvement the old literal
  // assertion would have blocked.
  assert.match(
    countersign,
    /dealerSignedAt: \w+/,
    "the envelope countersign must maintain the print columns",
  );
  assert.match(countersign, /dealerSignedByName: signedName/);
  assert.match(countersign, /dealerSignatureRef: signatureRef/);
  assert.match(countersign, /dealerSignedAt: null/, "…claimed conditionally, so a second call cannot overwrite the first");
});

test("a countersignature and its evidence commit together", () => {
  // The signing events and the quote's dealerSigned* columns used to be written
  // AFTER the transaction. A crash in between left a recipient marked signed
  // with no audit trail and an uncountersigned quote — and the retry could not
  // repair it, because the guard at the top sees status === "signed" and
  // returns ok straight away. There is no "partly signed" state worth having.
  const code = shipped("src/lib/signing/countersign.ts");
  const start = code.indexOf("prisma.$transaction");
  assert.notEqual(start, -1, "the transaction is gone — was it rewritten?");
  // Bounded FROM the start; an unbounded indexOf can slice backwards to empty.
  const tx = code.slice(start, code.indexOf("if (!claimed)", start));
  assert.ok(tx.length > 0, "the slice ran backwards");

  assert.match(tx, /tx\.signatureEvent\.create/, "the signing events belong inside the commit");
  assert.match(tx, /type: "signed"/, "…including the signed event itself");
  assert.match(tx, /tx\.quote\.updateMany/, "…and the quote's countersignature columns");

  // Nothing may write after the commit — that is the whole failure mode.
  const after = code.slice(code.indexOf("if (!claimed)", start));
  assert.doesNotMatch(after, /await (prisma|tx)\./, "no write may follow the commit");
  assert.doesNotMatch(after, /logSignEvent/, "logSignEvent uses its own client, so it lands outside the commit");
});

test("countersigning does not send the quote to the customer", () => {
  // advanceAfterSignature() emails the next signer the instant someone signs.
  // On a sequential envelope that meant the quote left for the customer as a
  // side effect of Denago signing, with nothing shown in between — the step
  // this whole flow exists to put back.
  const countersign = shipped("src/lib/signing/countersign.ts");
  assert.doesNotMatch(countersign, /advanceAfterSignature|dispatchRequest|notifyRecipient/, "sending is a separate, explicit act");

  // …and the separate act exists, gated on it being someone else's turn.
  const actions = shipped("src/app/actions/recordSigning.ts");
  const send = actionBody(actions, "sendRecordSigning");
  assert.match(send, /sendToRecipient\(state\.requestId, recipient\.id\)/);
  assert.match(send, /sameParty\(recipient\.email, user\.email\)/, "it must refuse to 'send' the document to the sender");
});

test("nobody signs in someone else's name", () => {
  // The countersign applies a stored signature with no human in front of the
  // document. Bound to the caller's own recipient row, or it is forgery.
  const body = actionBody(shipped("src/app/actions/recordSigning.ts"), "countersignRecord");
  assert.match(body, /sameParty\(recipient\.email, user\.email\)/, "the next signer must be the caller");
  assert.match(body, /drawnSignatureRef/, "…using the caller's own stored signature");
});

test("a field a stored signature cannot answer is refused, not invented", () => {
  // Auto-filling a text box or ticking a consent checkbox on behalf of a signer
  // who never saw it is putting words in their mouth.
  const code = shipped("src/lib/signing/countersign.ts");
  const guard = code.indexOf("else if (field.required)");
  assert.notEqual(guard, -1, "a required field of an un-fillable kind must stop the countersign");
  assert.ok(guard < code.indexOf("$transaction"), "…before anything is written");
});

test("the document is reviewed in place, not in an iframe of the app", () => {
  // The old modal iframed /signatures/<id>/sign/<recipient>, a page inside the
  // (app) route group — so AppShell rendered inside it and the mobile nav bar
  // sat across the signing controls.
  const card = shipped("src/components/SigningBlock.tsx");
  assert.doesNotMatch(card, /<iframe/, "the preview must not embed an app page");
  assert.doesNotMatch(card, /signFirstUrl/, "…nor navigate to a second signing surface");

  const preview = shipped("src/components/signing/SignedDocPreview.tsx");
  assert.doesNotMatch(preview, /<iframe/);
  assert.match(preview, /view\.sheets\.pages\.map/, "it renders the same sheet HTML the signing surface uses");
});

/**
 * Review findings on the consolidation. Each of these shipped green: the four
 * tests below are what would have caught them.
 */

test("the signed-document read is record-scoped for BOTH kinds", () => {
  // It checked `jobcards.manage` and then read by id. A module permission says
  // you may work with job cards, not WHICH — and the payload is the rendered
  // document plus every signature on it, so a record-scoped user could have
  // pulled another job card's by asking for it. Quotes were gated; job cards
  // were not.
  const body = actionBody(shipped("src/app/actions/recordSigning.ts"), "signedRecordDoc");
  assert.match(body, /canAccessQuote\(user, id\)/);
  assert.match(body, /canAccessJobCard\(user, id\)/, "a job card needs the same record-level gate");
  const gate = body.search(/canAccessJobCard/);
  const read = body.search(/activeRecordRequest/);
  assert.ok(gate !== -1 && gate < read, `the gate must precede the read (gate ${gate}, read ${read})`);
});

test("countersigning fills shared fields, not only its own", () => {
  // A field with recipientId null is fillable by EVERY signer — that is how the
  // public sign route scopes them. Loading only the assigned ones marked Denago
  // signed while a required shared consent tick sat empty, which then blocked
  // the customer's own submission on a field they never saw Denago skip.
  const code = shipped("src/lib/signing/countersign.ts");
  assert.match(code, /OR: \[\{ recipientId \}, \{ recipientId: null \}\]/, "shared fields must be loaded too");
  // …and a shared field is claimed first-write-wins, as the public route does,
  // so an earlier signer's answer is not overwritten.
  assert.match(code, /if \(value\.shared\)/);
  // `filledAt: null` in the predicate is what makes the claim first-write-wins;
  // the where clause also carries a tenant now, so match on the guard itself
  // rather than on the whole literal object.
  assert.match(code, /updateMany\(\{\s*where: \{[^}]*id: value\.id[^}]*filledAt: null[^}]*\}/);
});

test("a workflow does not reach anyone before the document is reviewed", () => {
  // advanceWorkflow() materialises AND notifies. Called on start, it emailed the
  // first signer immediately — so a workflow whose first node is the customer
  // reached them while the sender was still looking at the review screen.
  const actions = shipped("src/app/actions/recordSigning.ts");
  assert.doesNotMatch(actions, /advanceWorkflow\(requestId\)(?!,)/, "the start path must not notify");
  assert.match(actions, /advanceWorkflow\(requestId, \{ notify: false \}\)/);
  assert.match(actions, /repairWorkflow\([^)]*\{ notify: false \}\)/, "healing on start must not notify either");

  // The option has to actually reach the notification.
  const runtime = shipped("src/lib/signflow/runtime.ts");
  assert.match(runtime, /async function materialise\(requestId: string, node: SignNode, notify: boolean\)/);
  assert.match(runtime, /if \(!notify\) return;/, "notify:false must stop before notifyRecipient");
  assert.doesNotMatch(runtime, /await materialise\(requestId, (cur|next\.node)\);/, "every call site must pass it through");
});

test("a branched workflow acts on the live node, not the lowest order", () => {
  // A graph pre-creates a recipient for every path, so the lowest unsigned
  // `order` is routinely someone on a branch the condition never took —
  // countersigning, previewing or sending against them is the wrong party.
  // nextSigner is module-private, so slice it rather than using actionBody().
  const source = shipped("src/app/actions/recordSigning.ts");
  const start = source.indexOf("async function nextSigner(");
  assert.notEqual(start, -1, "nextSigner not found — was it renamed?");
  const body = source.slice(start, source.indexOf("\nconst sameParty", start));
  assert.match(body, /workflowGraphJson/, "a workflow envelope must be recognised");
  assert.match(body, /nodeId: request\.currentNodeId/, "…and resolved through the interpreter's live node");
  assert.match(body, /if \(!request\.currentNodeId\) return null/, "un-advanced means nobody is up yet");

  // The send must reach that same recipient — dispatchRequest picks its own
  // targets by order, which is wrong for a branch.
  const send = actionBody(shipped("src/app/actions/recordSigning.ts"), "sendRecordSigning");
  assert.match(send, /sendToRecipient\(state\.requestId, recipient\.id\)/);
  assert.doesNotMatch(send, /dispatchRequest\(/, "order-based dispatch cannot serve a branched graph");
});

test("Resend takes the resend path", () => {
  // dispatchRequest's claim excludes an already-"sent" request, so the button
  // that relabelled itself "Resend" reported a delivery failure every time.
  const card = shipped("src/components/SigningBlock.tsx");
  assert.match(card, /preview\.sent \? resendRecordSigning\(kind, id\) : sendRecordSigning\(kind, id\)/);
  const preview = shipped("src/components/signing/SignedDocPreview.tsx");
  assert.match(preview, /view\.sent[\s\S]{0,80}Resend/, "the label is what makes taking the wrong path a lie");
});

test("auto-placed signature fields get a page to themselves", () => {
  // They were dropped on the last content page at a fixed y of 985 — a guess
  // about where a document ends. A template whose content reached that far had
  // "For Denago Cape Town" printed across the middle of its terms block.
  const envelope = shipped("src/lib/signing/autoEnvelope.ts");
  assert.doesNotMatch(envelope, /y: 9[0-9][0-9]\b/, "no fixed near-the-foot coordinates may remain");
  assert.match(envelope, /doc\.pages\.push\(page\)/, "a clean page is appended instead");
  // Only when we would otherwise be inventing a position — a template that
  // places its own fields keeps its own layout, and gains no extra page.
  assert.match(envelope, /if \(signature\) \{/, "an existing placement must win");
});

test("the signature image is resolved from the session, never from the URL", () => {
  // saveFile() returns a Blob URL in production and a bare filename locally, so
  // there is no single ref an <img src> could load — and storage.ts already
  // records what handing a caller-supplied ref to the server cost last time.
  const route = read("src/app/api/me/signature/route.ts");
  assert.match(route, /export async function GET\(\)/, "the handler must take no request input at all");
  assert.match(route, /where: \{ id: user\.id \}/, "it must read the CALLER'S OWN signature");
  assert.doesNotMatch(route, /searchParams|params|req\./, "no ref, id or path segment may select the image");
  assert.match(route, /if \(!user\) return NextResponse\.json\(\{ error: "Unauthorized" \}, \{ status: 401 \}\)/);
  assert.match(route, /"Cache-Control": "private, no-store"/, "a personal signature must not be cached");
  assert.match(route, /"X-Content-Type-Options": "nosniff"/);
});

test("a public blob signature is loaded by the browser, not proxied", () => {
  // Signatures predating the private store are public Blob objects. Proxying
  // them made readFile() ask the Blob API to prove ownership, which needs a
  // token — so on a checkout without one the preview 404'd and showed nothing.
  const route = read("src/app/api/me/signature/route.ts");
  assert.match(route, /const direct = directReadUrl\(me\.drawnSignatureRef\)/);
  assert.match(route, /if \(direct\) return NextResponse\.redirect\(direct\)/);

  // The shape rules stay in the module that owns them — `startsWith("http")` in
  // a caller is the check storage.ts documents the cost of.
  const storage = read("src/lib/storage.ts");
  const fn = storage.slice(storage.indexOf("export function directReadUrl("));
  assert.match(fn.slice(0, fn.indexOf("}")), /!isTrustedBlobRef\(ref\) \|\| isPrivateBlobRef\(ref\)/, "a private blob still needs our token");
});

test("one destination for the printable quote keeps one name", () => {
  // The editor called it "Open PDF preview" and the record page called the very
  // same URL "Print / PDF", so the button people looked for read as missing
  // from the tab whose whole job is sending the quote out.
  const editor = shipped("src/components/quotes/QuoteEditorDialog.tsx");
  assert.match(editor, /Print \/ PDF<\/a>/, "the editor must use the name the rest of the app used");
  assert.doesNotMatch(editor, /Open PDF preview/, "the old name is what made it unrecognisable");
  assert.match(editor, /\/print`/, "and it must point at the printable document");
});

/**
 * Second review pass. Four more, three of which were real.
 */

test("a signed quote prints what was signed, not the template as it stands today", () => {
  // renderQuotePrintHtml resolved the CURRENT default builder template and drew
  // the completed request's signatures onto it. Edit the quote layout in
  // Document Studio afterwards — reword the terms, move the totals block — and
  // every already-signed quote reprinted with the new wording under the old
  // signature, at coordinates the old layout chose. SignatureRequest.snapshotJson
  // is the document the signature is evidence of.
  const source = shipped("src/lib/quotePrintDocument.ts");
  const start = source.indexOf("export async function renderQuotePrintHtml(");
  assert.notEqual(start, -1, "renderQuotePrintHtml not found — was it renamed?");
  // printToolbarHtml used to be declared below this and bounded the slice; it has
  // since moved to lib/printToolbar.ts, leaving renderQuotePrintHtml as the last
  // export in this file — so EOF genuinely IS the end of its body. Assert that
  // rather than trust it: append another export below and the slice would widen
  // silently, and these assertions would start reading someone else's code.
  const following = source.slice(start + 1).search(/^export /m);
  assert.equal(following, -1, "an export now follows renderQuotePrintHtml — bound the slice to it");
  const body = source.slice(start);

  assert.match(body, /parseDocument\(request\.snapshotJson\)/, "the frozen signed document must be what prints");
  const snapshot = body.search(/parseDocument\(request\.snapshotJson\)/);
  const template = body.search(/defaultBuilderTemplateId\("quote"\)/);
  assert.notEqual(template, -1, "the live template must remain the fallback for an UNSIGNED quote");
  assert.ok(snapshot < template, `the snapshot must be resolved first (snapshot ${snapshot}, template ${template})`);
  // ?tpl= is Document Studio previewing a LAYOUT against real data — that one
  // asked for the template and must get it.
  assert.match(body, /if \(!opts\.templateId && request\)/, "an explicit layout preview still wins");
  assert.match(body, /status: "completed"/, "only a COMPLETED request has a signed document to print");
});

test("an approval gate is not raised before the document is reviewed either", () => {
  // materialise() gated notify on the SIGNER branch only. A workflow with an
  // internal approval gate therefore emailed the approver the moment the graph
  // reached it — off the start path, or off the countersign — while the sender
  // was still looking at the review screen. Exactly the defect notify:false was
  // added to fix, on the branch it was not applied to.
  const runtime = shipped("src/lib/signflow/runtime.ts");
  const start = runtime.indexOf("async function materialise(");
  assert.notEqual(start, -1, "materialise not found — was it renamed?");
  const end = runtime.indexOf("\nexport async function advanceWorkflow", start);
  assert.notEqual(end, -1, "advanceWorkflow not found — the slice would run to EOF");
  const branchAt = runtime.indexOf('if (node.type === "approval") {', start);
  assert.ok(branchAt !== -1 && branchAt < end, "the decision-approval branch not found");
  const branch = runtime.slice(branchAt, end);

  const gate = branch.search(/if \(!notify\) return;/);
  const create = branch.search(/approvalStep\.createMany/);
  assert.notEqual(gate, -1, "the decision-approval branch must honour notify too");
  assert.notEqual(create, -1, "the step is still materialised by createMany");
  assert.ok(gate < create, `notify must be honoured BEFORE the row is inserted (gate ${gate}, create ${create})`);
  // Returning before the insert is what keeps the idempotency contract whole:
  // one row per node, and whoever inserted it is whoever notifies.
  assert.match(branch, /skipDuplicates: true/);
  assert.match(branch, /if \(created\.count === 0\) return;/, "only the inserting caller may notify");

  // Deferring must not strand the approver — the explicit send raises the gate.
  const send = actionBody(shipped("src/app/actions/recordSigning.ts"), "sendRecordSigning");
  assert.match(send, /pendingApprovalNode\(state\.requestId\)/, "the send must see a gate nextSigner() cannot");
  assert.match(send, /await advanceWorkflow\(state\.requestId\);/, "…and raise it WITH notification");
});

test("a resend reaches the recipient the graph is waiting on", () => {
  // dispatchRequest picks its targets by recipient ORDER. A branched graph
  // pre-creates a recipient for every path, so the lowest unsigned order is
  // routinely on a branch the condition never took — the resend nudged them with
  // a live signing link while the party actually holding up the deal heard
  // nothing. sendRecordSigning was fixed to use nextSigner(); the resend behind
  // the same document has to reach the same person.
  const body = actionBody(shipped("src/app/actions/recordSigning.ts"), "resendRecordSigning");
  assert.match(body, /nextSigner\(state\.requestId\)/, "a workflow resend must resolve through the live node");
  assert.match(body, /notifyRecipient\(recipient\.id, \{ reminder: true \}\)/, "…and remind exactly them");

  const workflow = body.search(/workflowGraphJson/);
  const dispatch = body.search(/dispatchRequest\(state\.requestId, \{ reminder: true \}\)/);
  assert.notEqual(workflow, -1, "a workflow envelope must be recognised");
  assert.notEqual(dispatch, -1, "a plain envelope keeps order-based dispatch — parallel resends need every signer");
  assert.ok(workflow < dispatch, `order-based dispatch must be the non-workflow branch (workflow ${workflow}, dispatch ${dispatch})`);
});

test("the start button never offers to countersign someone else's node", () => {
  // countersignRecord itself is safe — it refuses cleanly, and has its own test
  // above. The CARD was not: it fired countersignRecord after every successful
  // start, so a workflow whose first node is the customer answered "…signs next
  // — this is not yours to sign", and because run() bails on a failed result the
  // document never opened. The quote sat locked behind a request the card would
  // not show.
  const card = shipped("src/components/SigningBlock.tsx");
  const start = card.indexOf("const started = await startRecordSigning(");
  assert.notEqual(start, -1, "the start handler not found — was it rewritten?");
  const end = card.indexOf("})}", start);
  assert.notEqual(end, -1, "the handler's end not found — the slice would run to EOF");
  const handler = card.slice(start, end);

  const check = handler.search(/view\?\.next\?\.isMe/);
  const sign = handler.search(/countersignRecord\(kind, id\)/);
  assert.notEqual(check, -1, "who is up must decide whether to countersign");
  assert.notEqual(sign, -1, "the one-click countersign must survive for the built-in flow");
  assert.ok(check < sign, `the check must gate the countersign (check ${check}, sign ${sign})`);

  // And the review card offers the right button in that state.
  const preview = shipped("src/components/signing/SignedDocPreview.tsx");
  assert.match(preview, /const awaitingMe = view\.next\?\.isMe \?\? false;/);
  const guard = preview.indexOf("{awaitingMe ?");
  const offer = preview.indexOf("Countersign as Denago", guard === -1 ? 0 : guard);
  assert.notEqual(guard, -1, "the footer must branch on awaitingMe");
  assert.notEqual(offer, -1, "the countersign button not found");
  assert.ok(guard < offer, "the countersign button must sit inside the awaitingMe branch");
});

test("the editor does not freeze a quote just for opening the signature card", () => {
  // "Send for signature" saves a DRAFT. Freezing is the dispatch's job — it
  // marks the quote sent when the customer's link actually goes out. Saving as
  // `sent` here would cost a revision to anyone who reached the countersign pad
  // and changed their mind.
  const code = read("src/components/quotes/QuoteEditorDialog.tsx");
  assert.match(code, /save\("draft", \{ thenSign: true \}\)/, "the shortcut must not freeze the version");
  assert.match(code, /save\("sent"\)/, "…and the explicit mark-sent hand-off stays");
});
