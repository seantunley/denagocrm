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
 * Document access was an OR across every linked record, so a document reachable
 * through ANY of its links was reachable — including by someone who could not
 * open the record the document is actually ABOUT.
 *
 * That is not a corner case. Almost every document this app generates carries the
 * customer alongside its real subject: fulfilment.ts files the invoice, the proof
 * of payment, the delivery note and the delivery signature with `contactId` AND
 * `quoteId`; studio.ts and doceditor.ts do the same for generated PDFs;
 * recordSigning.ts and signing/complete.ts do it for the for-signing and signed
 * contracts; jobcards.ts files check-in/check-out photos with contact + job card;
 * portal.ts files customer uploads with contact + vehicle. So contact access
 * alone downloaded a quote's pricing and its signed terms.
 *
 * `authorizeUploadTarget` (actions/documents.ts) already refuses to file a NEW
 * hand-uploaded document against more than one record, and `moveDocument` clears
 * the other three links on every re-file. Multi-linked rows are therefore the
 * system-generated ones listed above (plus whatever history predates those
 * guards, which `replaceDocument` copies forward verbatim) — which is precisely
 * the population the union rule over-shared.
 *
 * The rule is now the one `signing/binding.ts` already states for signature
 * requests: ONE governing record, chosen by precedence.
 *
 * Behavioural where it can be — the precedence function is a pure module with no
 * server imports, exactly so this suite can execute it. Source-scanning for the
 * scope itself, which lives in permissions.ts and pulls in `server-only`.
 */

/** A body bounded FROM the start index. An unbounded end search finds an earlier
 *  occurrence and slices backwards into "", which passes every assertion. */
function bodyFrom(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} not found — was it renamed?`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} not found after ${startMarker}`);
  assert.ok(end > start, "the slice ran backwards");
  return source.slice(start, end);
}

const NO_LINKS = { quoteId: null, jobCardId: null, vehicleId: null, contactId: null };

test("ONE linked record governs a document, not whichever one the reader can reach", async () => {
  // THE BUG. A quote's invoice / signed contract is filed with the customer
  // attached, so "any link is enough" let contact access hand over the deal.
  const { governingDocumentLink } = await import("../src/lib/documents/governing");

  assert.deepEqual(
    governingDocumentLink({ quoteId: "q1", jobCardId: "j1", vehicleId: "v1", contactId: "c1" }),
    { kind: "quote", id: "q1" },
    "a quote outranks every other link",
  );
  assert.deepEqual(
    governingDocumentLink({ ...NO_LINKS, jobCardId: "j1", vehicleId: "v1", contactId: "c1" }),
    { kind: "jobcard", id: "j1" },
    "a job card outranks the vehicle it services and the customer who owns it",
  );
  assert.deepEqual(
    governingDocumentLink({ ...NO_LINKS, vehicleId: "v1", contactId: "c1" }),
    { kind: "vehicle", id: "v1" },
    "a portal upload is about the vehicle, not merely its owner",
  );
  assert.deepEqual(
    governingDocumentLink({ ...NO_LINKS, contactId: "c1" }),
    { kind: "contact", id: "c1" },
    "a contact-only document is still governed by the contact",
  );
  assert.equal(
    governingDocumentLink(NO_LINKS),
    null,
    "an unfiled repository document has no governing record",
  );
});

test("the contact link never decides for a document that has a commercial record", async () => {
  // The reported case, spelled out: the same contact id is present on all three,
  // and in none of them is it the answer.
  const { governingDocumentLink } = await import("../src/lib/documents/governing");
  for (const links of [
    { ...NO_LINKS, quoteId: "q1", contactId: "c1" }, // fulfilment invoice / signed PDF
    { ...NO_LINKS, jobCardId: "j1", contactId: "c1" }, // job-card check-in photo
    { ...NO_LINKS, vehicleId: "v1", contactId: "c1" }, // portal upload
  ]) {
    assert.notEqual(
      governingDocumentLink(links)?.kind,
      "contact",
      `contact access must not govern ${JSON.stringify(links)}`,
    );
  }
});

test("document precedence and signature-request precedence are the same list", () => {
  // recordSigning.ts stamps the SAME {quoteId, jobCardId, contactId} triple onto
  // the Document and onto the SignatureRequest built from it. Two precedence
  // lists that disagree would put a row's request under one record and its own
  // PDF under another — one file, two answers, which is the drift this rule
  // exists to prevent.
  const order = (rel: string, marker: string) => {
    const source = shipped(rel);
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `${marker} not found in ${rel}`);
    return [...source.slice(start).matchAll(/kind: "(\w+)"/g)].map((m) => m[1]);
  };
  const documents = order("src/lib/documents/governing.ts", "export function governingDocumentLink(");
  const requests = order("src/lib/signing/binding.ts", "export function governingBinding(");

  assert.deepEqual(documents, ["quote", "jobcard", "vehicle", "contact"]);
  assert.deepEqual(requests, ["quote", "jobcard", "document", "contact"]);
  // Every kind both rules know must appear in the same relative order.
  const shared = new Set(documents.filter((kind) => requests.includes(kind)));
  assert.deepEqual(
    documents.filter((kind) => shared.has(kind)),
    requests.filter((kind) => shared.has(kind)),
    "the two precedence lists disagree — a document and its signature request would answer to different records",
  );
});

test("the precedence rule is a pure module a test can actually run", () => {
  // Same reason signing/binding.ts is split out of signing/access.ts: the
  // security-critical half must be executable without the server stack, or the
  // only tests possible are source scans.
  const source = shipped("src/lib/documents/governing.ts");
  assert.doesNotMatch(source, /^import /m, "no imports — this must load in a plain test process");
  assert.doesNotMatch(source, /server-only/);
});

test("the document scope decides per DOCUMENT, not per link", () => {
  const code = shipped("src/lib/permissions.ts");
  const body = bodyFrom(code, "export async function getAccessibleDocumentIds(", "\nfunction idReach(");

  assert.match(body, /governingDocumentLink\(row\)/, "the governing link must decide");
  assert.match(body, /reachable\[link\.kind\]\(link\.id\)/, "…and it is that link's id that is checked");
  assert.match(body, /link !== null/, "a document with no governing record is a refusal");
  // THE VULNERABLE SHAPE: the OR-union's rows returned as the answer. It is now
  // only a pre-filter, so it must be narrowed before it becomes the id list.
  assert.match(body, /\.filter\(/, "the union must be narrowed, not returned");
  assert.doesNotMatch(
    body,
    /\}\);\s*return rows\.map\(\(row\) => row\.id\);/,
    "returning the OR-union unfiltered IS the bug — every link would grant again",
  );
});

test("the scope reads the link columns it has to rank", () => {
  // `select: { id: true }` was enough for a union answered entirely in SQL.
  // Precedence is decided per row, so the ranking columns have to come back —
  // and a missing one silently demotes that link to "absent".
  const code = shipped("src/lib/permissions.ts");
  const body = bodyFrom(code, "export async function getAccessibleDocumentIds(", "\nfunction idReach(");
  const select = bodyFrom(body, "select: {", "}");
  for (const column of ["id", "uploadedById", "quoteId", "jobCardId", "vehicleId", "contactId"]) {
    assert.match(select, new RegExp(`\\b${column}: true`), `the scope must select ${column}`);
  }
});

test("uploading a document still grants you that document", () => {
  // Deliberately INDEPENDENT of precedence: it is not derived from a linked
  // record, so no governing record can override it. uploadRepoDocument files
  // documents with no link at all — drop this grant and the uploader loses the
  // file the moment they save it, with nobody short of documents.view_all able
  // to open it. The uploader was authorised against the target at upload time
  // (authorizeUploadTarget), so this widens nothing.
  const code = shipped("src/lib/permissions.ts");
  const body = bodyFrom(code, "export async function getAccessibleDocumentIds(", "\nfunction idReach(");
  assert.match(
    body,
    /if \(row\.uploadedById === user\.id\) return true;/,
    "the uploader's own grant must survive the tightening",
  );
});

test("an unrestricted record scope is not confused with an empty one", () => {
  // getAccessible*Ids returns `null` for unrestricted and `[]` for "nothing".
  // The per-row check now consumes those lists directly, and reading `null` as
  // an empty Set would close the scope while reading `[]` as unrestricted would
  // open it.
  const code = shipped("src/lib/permissions.ts");
  const body = bodyFrom(code, "function idReach(", "\n}");
  assert.match(body, /if \(ids === null\) return \(\) => true;/, "null means unrestricted");
  assert.match(body, /new Set\(ids\)/, "…and a real list is matched by membership");
});

test("the tenant predicate #303 added is still on the query", () => {
  // Precedence narrows WHICH documents; it says nothing about WHOSE. basePrisma
  // bypasses RLS, so losing this predicate while rewriting the scope would
  // reopen cross-tenant reads under a tighter-looking rule.
  const code = shipped("src/lib/permissions.ts");
  const body = bodyFrom(code, "export async function getAccessibleDocumentIds(", "\nfunction idReach(");
  assert.match(body, /basePrisma\.document\.findMany/);
  assert.match(body, /\.\.\.documentTenantWhere\(\)/, "a basePrisma query must name its tenant");
  assert.match(shipped("src/lib/permissions.ts"), /activeTenantPredicate\("document scope"\)/);
});

test("no other module re-derives document access from the union", () => {
  // The single-source guard (documentScopeSingleSource.test.ts) covers the
  // scope's exported API; this covers the RULE. A page that filters documents by
  // `OR: [{ contactId: ... }, { quoteId: ... }]` of its own would reintroduce
  // the union next to a corrected permissions.ts.
  const source = shipped("src/lib/documents/governing.ts");
  assert.match(source, /export function governingDocumentLink\(/);
  const importers = ["src/lib/permissions.ts"];
  for (const rel of importers) {
    assert.match(
      shipped(rel),
      /from "\.\/documents\/governing"|from "@\/lib\/documents\/governing"/,
      `${rel} must resolve precedence from the shared module`,
    );
  }
});
