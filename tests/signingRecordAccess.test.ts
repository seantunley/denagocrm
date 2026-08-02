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

/**
 * `recordSigning.ts` already carries this rule — its `requireRecordSigningAccess`
 * comment records that module-only authorization "let any crm/workshop user
 * start/resend/void signing on ANY quote or job card by id".
 *
 * The Signatures HUB runs the same lifecycle operations on the same records and
 * never got the same treatment: every action in signhub.ts checked the
 * `signing.manage` CAPABILITY and then took the request id straight from the
 * caller. A capability is not an access decision.
 *
 * The reachable chain: point a recipient's email at yourself
 * (updateRecipientContact), resend, and the signing token arrives in your inbox
 * for a document you were never entitled to see.
 */

/** Body of a top-level exported function, up to the next one. */
function actionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} not found — was it renamed?`);
  const rest = source.slice(start + 1);
  const next = rest.indexOf("\nexport async function ");
  return next === -1 ? rest : rest.slice(0, next);
}

const RECORD_GATED = [
  "sendRequest",
  "resendRequest",
  "remindRecipient",
  "voidRequest",
  "updateRecipientContact",
];

test("every signature-request action checks access to the record, not just the capability", () => {
  const source = shipped("src/app/actions/signhub.ts");
  for (const name of RECORD_GATED) {
    const body = actionBody(source, name);
    assert.match(
      body,
      /resolveSignatureRequestAccess|canAccessSignatureRequest|canAccessRecipient/,
      `${name} authorises on the capability alone — it must also check access to the record`,
    );
  }
});

test("the access check comes before anything with an effect", () => {
  // Presence is not enough — a check that runs after the send has already gone
  // out protects nothing. Assert ORDER: in every gated action the access
  // decision must precede the first side-effecting call.
  //
  // (An earlier version of this test pattern-matched the vulnerable shape
  // instead. It passed on code that was fine and failed on code that was also
  // fine, because an intervening `if (!r) return` ended the match before the
  // check it was looking for. Ordering is the property that actually matters.)
  const EFFECTS =
    /\b(dispatchRequest|notifyRecipient|logSignEvent|logAudit|prisma\.\w+\.(update|updateMany|create|delete|deleteMany))\(/;
  const source = shipped("src/app/actions/signhub.ts");
  for (const name of RECORD_GATED) {
    const body = actionBody(source, name);
    const gate = body.search(/resolveSignatureRequestAccess|canAccessSignatureRequest|canAccessRecipient/);
    const effect = body.search(EFFECTS);
    assert.notEqual(gate, -1, `${name} has no access check at all`);
    assert.notEqual(effect, -1, `${name} has no side effect — has it been renamed or gutted?`);
    assert.ok(
      gate < effect,
      `${name} acts before it authorises (gate at ${gate}, first effect at ${effect})`,
    );
  }
});

test("the access decision is by source record", () => {
  const access = read("src/lib/signing/access.ts");
  for (const fn of ["canAccessQuote", "canAccessJobCard", "canAccessDocument", "canAccessContact"]) {
    assert.match(access, new RegExp(`\\b${fn}\\(`), `${fn} must take part in the decision`);
  }
});

test("ONE authoritative binding decides, not whichever one the caller can reach", async () => {
  // The first version of this module asked every binding and allowed if ANY
  // said yes. Most requests carry several at once — the one in production
  // carries a quote, a contact AND a document — so that rule let a role with
  // signing.manage plus documents.view_all (or merely access to the customer)
  // act on a request for a quote it cannot open. Precedence closes it: the
  // document is GENERATED from the quote and the contact is merely its
  // customer, so neither is evidence of access to the deal.
  const { governingBinding } = await import("../src/lib/signing/binding");
  const none = { quoteId: null, jobCardId: null, documentId: null, contactId: null, createdById: null };

  assert.deepEqual(
    governingBinding({ ...none, quoteId: "q1", jobCardId: "j1", documentId: "d1", contactId: "c1" }),
    { kind: "quote", id: "q1" },
    "a quote outranks every other binding",
  );
  assert.deepEqual(
    governingBinding({ ...none, jobCardId: "j1", documentId: "d1", contactId: "c1" }),
    { kind: "jobcard", id: "j1" },
  );
  assert.deepEqual(
    governingBinding({ ...none, documentId: "d1", contactId: "c1" }),
    { kind: "document", id: "d1" },
  );
  assert.deepEqual(governingBinding({ ...none, contactId: "c1" }), { kind: "contact", id: "c1" });
  assert.equal(governingBinding(none), null, "an unbound request has no governing record");
});

test("the decision never widens by asking several bindings at once", () => {
  // Structural backstop for the behavioural test above: the shape that caused
  // the bug was collecting checks and OR-ing them.
  const access = shipped("src/lib/signing/access.ts");
  assert.doesNotMatch(access, /\.some\(Boolean\)/, "an any-binding rule is a bypass, not a convenience");
  assert.doesNotMatch(access, /Promise\.all\(checks\)/);
});

test("an unbound request fails safe rather than throwing or allowing", () => {
  // A request with no quote/jobcard/contact/document has no record to decide
  // from. Production has none today; this pins the fallback so a future one
  // cannot silently become open to every signing.manage holder.
  const access = shipped("src/lib/signing/access.ts");
  assert.match(access, /const binding = resolveBinding\(request\)/);
  assert.match(access, /createdById === user\.id/, "the creator keeps access");
  assert.match(
    access,
    /getAccessibleQuoteIds\(user\)\) === null/,
    "otherwise only an unrestricted scope may act",
  );
});

test("refusal is indistinguishable from absence", () => {
  // "Not found" for both cases. Two different answers would turn these actions
  // into an existence oracle for other people's documents.
  const source = shipped("src/app/actions/signhub.ts");
  const send = actionBody(source, "sendRequest");
  assert.match(send, /if \(!access\) return \{ ok: false, error: "Not found" \}/);
  assert.doesNotMatch(source, /"You (do not|don't) have access/i);
  assert.doesNotMatch(source, /Forbidden|Not permitted|Unauthorised|Unauthorized/i);
});

test("redirecting where a signing link is delivered leaves an audit trail", () => {
  // The most sensitive mutation in the file had NO audit entry at all, so a
  // redirected recipient was invisible afterwards.
  const body = actionBody(shipped("src/app/actions/signhub.ts"), "updateRecipientContact");
  assert.match(body, /logAudit\(\{/, "a contact change must be auditable");
  assert.match(body, /signing\.recipient_contact_changed/);
  assert.match(body, /before:\s*\{\s*email:\s*r\.email/, "the audit must record what it was before");
});

test("the doc builder checks access to the record it renders", () => {
  // `docbuilder.manage` let a holder render ANY quote's or job card's pricing
  // and customer details into a PDF and file it. The mailing half of that —
  // sendDocForSigning — has since been removed with the editor's "Prepare for
  // signing" button, so one call site remains: generate-and-file.
  const source = shipped("src/app/actions/doceditor.ts");
  const start = source.indexOf("async function validatedBinding(");
  const body = source.slice(start, source.indexOf("export async function", start));
  assert.match(body, /canAccessQuote\(user, record\.id\)/);
  assert.match(body, /canAccessJobCard\(user, record\.id\)/);
  assert.match(body, /throw new ActionRefusal/);
  // EVERY call site must pass a real authenticated user through — the count is
  // asserted so a new one added without the user is caught, not just tolerated.
  const calls = source.match(/validatedBinding\(user, templateId, record\)/g) ?? [];
  assert.equal(calls.length, 1);
  assert.equal((source.match(/validatedBinding\(/g) ?? []).length, calls.length + 1, "…including the declaration");
});

test("the paths that were already correct stay correct", () => {
  // recordSigning.ts is the reference implementation this fix mirrors. If its
  // gate ever disappears, the argument in signing/access.ts loses its footing.
  const source = shipped("src/app/actions/recordSigning.ts");
  assert.match(source, /requireQuoteAccess\(id, "quotes\.change_status"\)/);
  assert.match(source, /requireJobCardAccess\(id, "jobcards\.manage"\)/);
});
