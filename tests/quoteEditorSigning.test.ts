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

  for (const rel of ["src/components/SigningBlock.tsx", "src/components/DealerSignPad.tsx"]) {
    const component = shipped(rel);
    assert.equal(
      (component.match(/router\.refresh\(\)/g) ?? []).length,
      1,
      `${rel} must route every refresh through the wrapper that also notifies the embedder`,
    );
    assert.match(
      component,
      /onChanged\?\.\(\)|onSigned\?\.\(\)/,
      `${rel} never notifies an embedder, so an embedded card goes stale`,
    );
  }
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

test("the countersign pad shows the signature it is about to stamp", () => {
  // "Sign as Denago (your saved signature)" committed a signature onto a
  // customer-facing document that the signer had no way to look at first.
  const pad = shipped("src/components/DealerSignPad.tsx");
  assert.match(pad, /src="\/api\/me\/signature"/, "the saved signature must be previewed");
  const previewAt = pad.indexOf('src="/api/me/signature"');
  const buttonAt = pad.indexOf("Sign as Denago");
  assert.ok(previewAt > 0 && previewAt < buttonAt, "the preview belongs above the button that commits it");
  assert.match(pad, /onError=\{\(\) => setPreviewFailed\(true\)\}/, "a ref whose bytes are gone must not leave a broken frame");
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
  const record = shipped("src/app/(app)/quotes/[id]/page.tsx");
  assert.match(editor, /Print \/ PDF<\/a>/, "the editor must use the name the rest of the app uses");
  assert.doesNotMatch(editor, /Open PDF preview/, "the old name is what made it unrecognisable");
  for (const [rel, code] of [["editor", editor], ["record page", record]] as const) {
    assert.match(code, /\/print`/, `the ${rel} must point at the printable document`);
  }
  assert.match(record, /🖨 Print \/ PDF/, "…and the record page keeps saying the same thing");
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
