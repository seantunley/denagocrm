import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 2026-09-30: the owner was working on Q-1026. The page reloaded onto a stale
 * `?edit=Q-1022` (opening a quote from the list never rewrote the URL), the
 * editor came back showing Q-1022, and "✍ Countersign & review" mailed Q-1022
 * to its customer on the spot — the quote layout had no Denago signature block,
 * so startRecordSigning fell through to dispatchRequest() with no review.
 *
 * Three independent guards, each pinned here:
 *   1. ?edit= always names the quote on screen (a reload reopens THAT quote);
 *   2. starting signing never contacts anyone — only an explicit Send does;
 *   3. a send is refused unless it is for the document the sender reviewed.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shipped = (rel: string) =>
  readFileSync(path.join(root, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

function actionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} not found — was it renamed?`);
  // Up to the function's own closing brace at column 0 — NOT the next export,
  // which would sweep in the private helpers that follow it.
  const rest = source.slice(start);
  const end = rest.search(/\r?\n\}\r?\n/);
  assert.notEqual(end, -1, `${name}: closing brace not found`);
  return rest.slice(0, end) + "\n}";
}

const actions = shipped("src/app/actions/recordSigning.ts");
const card = shipped("src/components/SigningBlock.tsx");

test("?edit= is rewritten to the quote on screen, so a reload reopens the right one", () => {
  const code = shipped("src/components/quotes/QuoteEditorDialog.tsx");
  const provider = code.slice(code.indexOf("export function QuoteEditorProvider("));
  const effect = provider.match(/useEffect\(\(\) => \{([\s\S]*?)\}, \[selectedId\]\);/);
  assert.ok(effect, "the provider must sync the URL whenever the selected quote changes");
  assert.match(effect[1], /searchParams\.set\("edit", selectedId\)/, "opening/switching must write ?edit=");
  assert.match(effect[1], /searchParams\.delete\("edit"\)/, "closing must clear ?edit=, or a reload reopens it");
  assert.match(effect[1], /window\.history\.replaceState\(/);
  assert.match(provider, /const selectedId = selection\?\.quoteId \?\? null;/);

  // Adopting a changed ?edit= must read the ROUTER's URL. The server prop can
  // arrive from an in-flight router.refresh() carrying the previous ?edit=.
  assert.match(provider, /useSearchParams\(\)\.get\("edit"\)/);
  const afterSeed = provider.slice(provider.indexOf("const selectedId"));
  assert.doesNotMatch(afterSeed, /initialQuoteId/, "initialQuoteId may seed the first render only");
});

test("starting signing never contacts the customer", () => {
  const start = actionBody(actions, "startRecordSigning");
  for (const sender of ["dispatchRequest(", "notifyRecipient(", "sendToRecipient(", "notifyNextInSequence("]) {
    assert.ok(!start.includes(sender), `startRecordSigning must not call ${sender} — only Send may`);
  }
  // Every workflow advance on the start path is silent.
  for (const call of start.match(/advanceWorkflow\([^)]*\)/g) ?? []) {
    assert.match(call, /notify: false/, `${call} would notify the first signer`);
  }
  for (const call of start.match(/repairWorkflow\([^)]*\)/g) ?? []) {
    assert.match(call, /notify: false/, `${call} would notify the first signer`);
  }
  // The built-in path — with or without a Denago block — ends on the review.
  assert.match(start, /await logStartAudit\("Started"\);\s*return \{ ok: true, requestId, preview: true \};\s*\}\);\s*\}$/);
});

test("send and resend refuse a document other than the one reviewed", () => {
  for (const name of ["sendRecordSigning", "resendRecordSigning"]) {
    const body = actionBody(actions, name);
    assert.match(body, /reviewedRequestId: string/, `${name} must require the reviewed request id`);
    const guard = body.indexOf("notTheReviewedDocument(state.requestId, reviewedRequestId)");
    assert.notEqual(guard, -1, `${name} must compare the live request with the reviewed one`);
    for (const sender of ["sendToRecipient(", "dispatchRequest(", "notifyRecipient(", "advanceWorkflow("]) {
      const at = body.indexOf(sender);
      if (at !== -1) assert.ok(guard < at, `${name}: the check must run before ${sender}`);
    }
  }
  assert.match(actions, /const notTheReviewedDocument = \(liveRequestId: string, reviewedRequestId: string\) =>\s*liveRequestId !== reviewedRequestId;/);

  // The card sends what it rendered.
  assert.match(card, /sendRecordSigning\(kind, id, preview\.requestId\)/);
  assert.match(card, /resendRecordSigning\(kind, id, preview\.requestId\)/);
  assert.match(card, /resendRecordSigning\(kind, id, state\.requestId\)/);
  assert.doesNotMatch(card, /(?:re)?sendRecordSigning\(kind, id\)/, "no send may go out without the reviewed id");
});

test("Quick create closes for real when the route changes", () => {
  const code = shipped("src/components/QuickCreateDialog.tsx");
  assert.match(code, /const pathname = usePathname\(\);/);
  assert.match(
    code,
    /if \(pathname !== openedPathname\) \{\s*setOpenedPathname\(pathname\);\s*if \(kind\) \{\s*setKind\(null\);/,
    "a hidden quote editor must not stay mounted across routes",
  );
});
