import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { documentRequestState, requestDays, requestedFileName, requestEmail, requestFileKind } from "../src/lib/documentRequestRules";

/** A supplier is asked for one of its papers through an upload link (review section D, 2026-11-09). */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const at = new Date("2026-11-10T10:00:00Z");

test("a request is open until it is answered, withdrawn or out of time — answered wins", () => {
  const base = { expiresAt: new Date("2026-11-17T10:00:00Z"), revokedAt: null, fulfilledAt: null };
  assert.equal(documentRequestState(base, at), "open");
  assert.equal(documentRequestState({ ...base, fulfilledAt: at, revokedAt: at }, at), "received");
  assert.equal(documentRequestState({ ...base, revokedAt: at }, at), "recalled");
  assert.equal(documentRequestState({ ...base, expiresAt: at }, at), "expired");
  assert.equal(requestDays("14"), 14);
  assert.equal(requestDays("999"), 7, "only the offered choices");
});

test("a file is judged by its own first bytes, not the name or type the browser claims", () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);
  assert.deepEqual(requestFileKind(bytes(0x25, 0x50, 0x44, 0x46, 0x2d)), { mimeType: "application/pdf", extension: "pdf" });
  assert.deepEqual(requestFileKind(bytes(0xff, 0xd8, 0xff, 0xe0)), { mimeType: "image/jpeg", extension: "jpg" });
  assert.deepEqual(requestFileKind(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), { mimeType: "image/png", extension: "png" });
  assert.deepEqual(requestFileKind(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), { mimeType: "image/webp", extension: "webp" });
  assert.equal(requestFileKind(new TextEncoder().encode("<html><script>")), null, "an HTML page named invoice.pdf is refused");
  assert.equal(requestFileKind(bytes(0x4d, 0x5a)), null, "a program is refused");
});

test("what is filed is named for what it is and who sent it; the email names no customer", () => {
  assert.equal(requestedFileName({ documentType: "Supplier invoice", vendorName: "Wrap/Studio", quoteNumber: 1029, extension: "pdf" }), "Supplier invoice — Wrap Studio — Q-1029.pdf");
  const mail = requestEmail({ brand: "Denago Cape Town", vendorName: "Wrap Studio", documentType: "Supplier invoice", quoteNumber: 1029, link: "https://crm.example/u/abc", expiresLabel: "17 Nov" });
  assert.equal(mail.subject, "Denago Cape Town: please upload your supplier invoice for Q-1029");
  assert.match(mail.text, /https:\/\/crm\.example\/u\/abc/);
});

test("the public page and upload route are reachable without signing in, and check the link every time", () => {
  const proxy = read("src/proxy.ts");
  assert.match(proxy, /"\/u",\s*"\/api\/u",/);
  const route = read("src/app/api/u/[token]/route.ts");
  assert.match(route, /throttlePublic\("document-request", token, PUBLIC_ACTION_POLICY\)/);
  assert.match(route, /if \(request\.state !== "open"\) return back\(""\);/);
  assert.match(route, /if \(file\.size > REQUEST_MAX_BYTES\) return back\("error=size"\);/);
  assert.match(route, /const kind = requestFileKind\(bytes\.subarray\(0, 16\)\);\s*if \(!kind\) return back\("error=type"\);/);
  // ONE file, once: claimed conditionally, and the losing upload's bytes removed.
  assert.match(route, /where: \{ id: request\.id, tenantId: request\.tenantId, fulfilledAt: null, revokedAt: null, expiresAt: \{ gt: new Date\(\) \} \}/);
  assert.match(route, /if \(!filed\) \{\s*await deleteFile\(storedName\)/);
  assert.match(route, /tag: request\.documentType,\s*vendorId: request\.vendorId,/);
  assert.match(read("src/lib/documentRequests.ts"), /token: hashSignToken\(token\)/);
  assert.match(read("src/lib/tokenTenant.ts"), /export async function resolveDocumentRequestTenant\(/);
});

test("staff send nothing without a click; a failed email leaves no working link; the module and a supplier paper are required", () => {
  const action = read("src/app/actions/documentRequests.ts");
  assert.match(action, /const user = await requireQuoteAccess\(quoteId, "documents\.upload"\);/);
  assert.match(action, /if \(!\(await isModuleEnabled\("suppliers"\)\)\) refuse\(/);
  // Only a paper on THIS supplier's list (its own, or the default — 2026-11-10).
  assert.match(action, /const asked = typesForSupplier\(await getDealFileConfig\(\), vendor\.requiredDocuments\);\s*if \(!asked\.includes\(documentType\) \|\| !types\.includes\(documentType\)\) refuse\(/);
  assert.match(action, /if \(!sent\.ok\) \{\s*\/\/ Not sent: the link must not be left working\.\s*await prisma\.documentRequest\.updateMany\(\{ where: \{ id: request\.id, tenantId \}, data: \{ revokedAt: new Date\(\) \} \}\);/);
  assert.match(action, /action: "deal\.document_requested",/);
  const page = read("src/app/(app)/deals/[id]/page.tsx");
  assert.match(page, /<DocumentRequestButton quoteId=\{uploadQuoteId \?\? quote\.id\} vendor=\{ask\.vendor\} documentType=\{ask\.documentType\} \/>/);
  assert.match(page, /recallDocumentRequest\.bind\(null, waiting\.quoteId, waiting\.id\)/);
});
