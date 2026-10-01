import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #30: files customers uploaded through the portal without picking a
// case had no staff screen anywhere, and nothing told anyone they had arrived.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("staff are told when a customer uploads", () => {
  const action = src("src/app/actions/portalExpansion.ts");
  const upload = action.slice(action.indexOf("export async function uploadPortalFile("));
  assert.match(upload, /sendPushToAll\(\{\s*title: "Customer uploaded a document",/);
  assert.match(upload, /url: caseId \? `\/cases\/\$\{caseId\}` : `\/contacts\/\$\{contact\.id\}`/);
  assert.match(src("src/lib/push.ts"), /\{ id: "portal_upload", label: "Customer uploads",/);
});

test("every upload shows on the customer's Documents tab, case or not", () => {
  const page = src("src/app/(app)/contacts/[id]/page.tsx");
  assert.match(page, /prisma\.portalUpload\.findMany\(\{\s*where: \{ contactId: contact\.id \}/);
  assert.match(page, /<PortalUploadsList uploads=\{portalUploads\} canReview=\{canReviewUploads\} \/>/);
});

test("unreviewed uploads are queued on Documents, limited to customers the viewer may see", () => {
  const page = src("src/app/(app)/documents/page.tsx");
  assert.match(page, /where: \{ status: "received", \.\.\.\(contactIds === null \? \{\} : \{ contactId: \{ in: contactIds \} \}\) \}/);
  assert.match(page, /<PortalUploadsList uploads=\{newPortalUploads\} canReview=\{canManage\} \/>/);
});

test("reviewing is gated on the customer, audited, and downloads go through the authorising route", () => {
  const action = src("src/app/actions/portalUploads.ts");
  assert.match(action, /await requirePermission\("documents\.manage"\);/);
  assert.match(action, /const user = await requireContactAccess\(upload\.contactId, "documents\.manage"\);/);
  assert.match(action, /action: "portal\.file_reviewed"/);
  assert.match(src("src/components/PortalUploadsList.tsx"), /href=\{`\/api\/cases\/uploads\/\$\{upload\.id\}`\}/);
});
