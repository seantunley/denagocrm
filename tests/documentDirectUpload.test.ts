import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  MAX_DOCUMENT_BYTES,
  cleanDocumentFileName,
  documentTargetKey,
  documentUploadPrefix,
  parseDocumentTarget,
} from "../src/lib/documentUpload";
import { parsePhotoPath } from "../src/lib/photoOrphanRules";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

/**
 * Documents over 4 MB could not be uploaded: they went through a Server Action,
 * and Vercel refuses a function request body over 4.5 MB before the action runs.
 * They could not have been opened either — /api/files built its response from a
 * Buffer, and Vercel caps an unstreamed response at 4.5 MB too.
 *
 * Now: browser → Blob storage under a signed path, then registered; downloads
 * stream. These tests pin the rules that keep that safe.
 */

/* ── the path is the permission ────────────────────────────────────── */

test("EACH TARGET GETS ITS OWN PATH, UNDER ITS WORKSPACE", () => {
  assert.equal(documentTargetKey({ kind: "company" }), "company");
  assert.equal(documentTargetKey({ kind: "record", field: "quoteId", id: "q1" }), "quote-q1");
  assert.equal(documentTargetKey({ kind: "record", field: "contactId", id: "c1" }), "contact-c1");
  assert.equal(documentTargetKey({ kind: "record", field: "vehicleId", id: "v1" }), "vehicle-v1");
  assert.equal(documentTargetKey({ kind: "record", field: "jobCardId", id: "j1" }), "jobcard-j1");

  assert.equal(
    documentUploadPrefix("tenant_a", { kind: "record", field: "quoteId", id: "q1" }),
    "uploads/tenant_a/document/quote-q1/",
  );
  // Two different records never share a prefix, so a file authorised for one
  // cannot pass the other's prefix check.
  assert.ok(!documentUploadPrefix("t", { kind: "record", field: "quoteId", id: "q1" })
    .startsWith(documentUploadPrefix("t", { kind: "record", field: "quoteId", id: "q" })));
});

test("AN UPLOAD NEVER REGISTERED IS SWEPT LIKE AN ORPHAN PHOTO", () => {
  const stored = `${documentUploadPrefix("tenant_a", { kind: "company" })}abc-contract.pdf`;
  assert.deepEqual(parsePhotoPath(stored), { tenantId: "tenant_a", kind: "document", recordId: "company" });
});

test("THE BROWSER'S TARGET AND FILE NAME ARE VALIDATED, NOT TRUSTED", () => {
  assert.deepEqual(parseDocumentTarget('{"kind":"company"}'), { kind: "company" });
  assert.deepEqual(parseDocumentTarget({ kind: "record", field: "quoteId", id: "q_1-a" }), {
    kind: "record", field: "quoteId", id: "q_1-a",
  });
  for (const bad of [
    '{"kind":"record","field":"tenantId","id":"x"}', // not a document link
    '{"kind":"record","field":"quoteId","id":"../../x"}', // path traversal in the id
    '{"kind":"record","field":"quoteId"}',
    "not json",
    '{"kind":"everything"}',
  ]) {
    assert.throws(() => parseDocumentTarget(bad), `refuses ${bad}`);
  }

  assert.equal(cleanDocumentFileName("C:\\Users\\sean\\contract.pdf"), "contract.pdf", "no directory part");
  assert.equal(cleanDocumentFileName("../../etc/passwd"), "passwd");
  assert.equal(cleanDocumentFileName("inv\u0000oice\u0007.pdf"), "invoice.pdf", "no control characters");
  assert.equal(cleanDocumentFileName(""), "Document");
  assert.equal(cleanDocumentFileName("x".repeat(500)).length, 200);
});

test("THE LIMIT IS FAR PAST THE OLD 4 MB", () => {
  assert.equal(MAX_DOCUMENT_BYTES, 100 * 1024 * 1024);
});

/* ── the token route ───────────────────────────────────────────────── */

test("THE TOKEN ROUTE SIGNS ONLY AN AUTHORISED UPLOAD, FOR ITS OWN PATH", () => {
  const route = stripComments(src("src/app/api/documents/upload/route.ts"));
  const before = route.slice(route.indexOf("onBeforeGenerateToken"), route.indexOf("onUploadCompleted"));
  const permAt = before.indexOf('await requirePermission("documents.upload");');
  const authAt = before.indexOf("await authorizeDocumentTarget(target, tenantId);");
  const pathAt = before.indexOf("if (!pathname.startsWith(documentUploadPrefix(tenantId, target)))");
  assert.ok(permAt > 0 && authAt > permAt && pathAt > authAt, "permission, then record and workspace, then path");
  assert.match(before, /maximumSizeInBytes: MAX_DOCUMENT_BYTES,/);
  assert.match(route, /return withActingStaffScope\(async \(\) => \{/, "the token exchange runs in the staff session");
  assert.match(route, /!request\.headers\.get\("x-vercel-signature"\)/, "an unsigned completion callback is refused");
});

/* ── the register action ───────────────────────────────────────────── */

test("REGISTERING A STORED FILE RE-CHECKS EVERYTHING AND TRUSTS NOTHING FROM THE BROWSER", () => {
  const actions = stripComments(src("src/app/actions/documents.ts"));
  const body = actions.slice(
    actions.indexOf("export async function registerUploadedDocument"),
    actions.indexOf("export async function deleteDocument"),
  );
  const order = [
    'await requirePermission("documents.upload");',
    "const tenantId = await actingTenantId();",
    "const user = await authorizeDocumentTarget(target, tenantId);",
    "blob = await assertOwnedBlob(url, tenantId);",
    "if (!blob.pathname.startsWith(prefix))",
    "await prisma.document.create(",
  ].map((needle) => body.indexOf(needle));
  assert.ok(order.every((at) => at > 0), "every check is present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "and runs before the row is written");

  // Size and type come from the store, never the request.
  assert.match(body, /sizeBytes: blob\.size,/);
  assert.match(body, /mimeType: blob\.contentType \|\| "application\/octet-stream",/);
  assert.match(body, /if \(blob\.size > MAX_DOCUMENT_BYTES\)/);
  assert.match(body, /tenantId,\s*fileName,\s*storedName: url,/, "the row is owned by the workspace that holds the file");

  // A refused file is removed — only through the ownership-checking delete.
  assert.match(body, /await deleteOwnedBlob\(url, tenantId, prefix\)/);
  assert.ok(!/\bdeleteFile\(/.test(body), "never the unchecked delete, which could remove another workspace's file");
});

test("ONCE THE ROW EXISTS, NOTHING MAY DELETE ITS FILE", () => {
  /*
   * Review finding: the audit write sat inside the same try as the insert, so a
   * failing audit would have run the clean-up and deleted a file a freshly
   * written Document row pointed at — a document that opens to "missing".
   */
  const actions = stripComments(src("src/app/actions/documents.ts"));
  const body = actions.slice(
    actions.indexOf("export async function registerUploadedDocument"),
    actions.indexOf("export async function deleteDocument"),
  );
  const createAt = body.indexOf("doc = await prisma.document.create(");
  const afterCreate = body.slice(body.indexOf("} catch (error) {", createAt));
  // The only call to discard() after the insert is the insert's own catch.
  assert.equal((afterCreate.match(/discard\(/g) ?? []).length, 1, "only a failed insert may discard the file");
  const auditAt = body.indexOf("await logAudit(");
  const insertCatchEnd = body.indexOf("return discard(error);", createAt) + "return discard(error);".length;
  assert.ok(auditAt > insertCatchEnd, "the audit write is outside every clean-up path");
  // And the delete itself lives only in discard().
  assert.equal((body.match(/deleteOwnedBlob\(/g) ?? []).length, 1);
});

test("EVERY TARGET IS CHECKED FOR ACCESS AND FOR WORKSPACE", () => {
  const auth = stripComments(src("src/lib/documentUploadAuth.ts"));
  for (const [field, guard, model] of [
    ["contactId", "requireContactAccess", "contact"],
    ["vehicleId", "requireVehicleAccess", "vehicle"],
    ["jobCardId", "requireJobCardAccess", "jobCard"],
    ["quoteId", "requireQuoteAccess", "quote"],
  ]) {
    const branch = auth.slice(auth.indexOf(`case "${field}":`), auth.indexOf("break;", auth.indexOf(`case "${field}":`)));
    assert.match(branch, new RegExp(`${guard}\\(id, "documents\\.upload"\\)`), `${field}: record access`);
    assert.match(branch, new RegExp(`basePrisma\\.${model}\\.findFirst\\(\\{ where: \\{ id, tenantId \\}`), `${field}: in this workspace`);
  }
  assert.match(auth, /if \(!inWorkspace\) throw new Error/);
  assert.match(auth, /if \(target\.kind === "company"\) return requirePermission\("documents\.upload"\);/);
});

/* ── downloads stream ──────────────────────────────────────────────── */

test("DOWNLOADS STREAM, WITH THE SAME OWNERSHIP CHECKS", () => {
  const route = stripComments(src("src/app/api/files/[id]/route.ts"));
  assert.match(route, /const stream = await openFileStream\(doc\.storedName, doc\.tenantId\);/);
  assert.ok(!/readFile\(/.test(route), "the buffered read — capped at 4.5 MB by Vercel — is gone from this route");

  const storage = stripComments(src("src/lib/storage.ts"));
  // openFileStream is a wrapper; the reading, with its checks, is openStoredFile.
  assert.match(storage, /return \(await openStoredFile\(ref, expectedTenantId\)\)\.stream;/);
  const stream = storage.slice(storage.indexOf("export async function openStoredFile"), storage.indexOf("export function isStoredFileRef"));
  assert.ok(stream.length > 500, "found openStoredFile");
  assert.match(stream, /if \(!ownedByExpected\(pathname, expectedTenantId\)\) \{\s*throw new BlobNotYoursError/, "private store: workspace checked before the read");
  assert.match(stream, /if \(error instanceof BlobNotYoursError\) throw error;/, "a refusal is not treated as a miss");
  assert.match(stream, /await assertOwnedBlob\(ref, expectedTenantId\);/, "public path: proven ours and this workspace's");
  // The timeout must not cover the body, or a large file is cut off mid-download.
  assert.ok(!/AbortSignal\.timeout/.test(stream), "no whole-request timeout on a stream");
  assert.match(stream, /clearTimeout\(timer\);/);
});

/* ── the browser ───────────────────────────────────────────────────── */

test("THE BROWSER UPLOADS DIRECTLY, AND FALLS BACK ONLY WITHOUT A STORE", () => {
  const hook = stripComments(src("src/components/documents/useDocumentUploads.ts"));
  assert.match(hook, /if \(access && tenantId\) \{/);
  assert.match(hook, /handleUploadUrl: "\/api\/documents\/upload",/);
  assert.match(hook, /await registerUploadedDocument\(\{ target, url: blob\.url, fileName: file\.name \}\)/);
  assert.match(hook, /\$\{documentUploadPrefix\(tenantId, target\)\}/, "the path the server will check, built by the shared helper");
  // The Server Action fallback keeps its honest 4 MB limit.
  assert.match(hook, /const FORM_UPLOAD_MAX_BYTES = 4 \* 1024 \* 1024;/);

  const page = stripComments(src("src/app/(app)/documents/page.tsx"));
  assert.match(page, /<DocumentUploader target=\{uploadTarget\} tenantId=\{tenantId\} hint=\{uploadHint\} \/>/, "the phone's capture uses it too");
});
