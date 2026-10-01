import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #32: (1) a request every signer signed, whose quote/job card changed
// after sending, can never complete — and completion returned silently, leaving
// it open forever. (2) A completed request whose signed-copy email failed looked
// exactly like one that succeeded.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const complete = src("src/lib/signing/complete.ts");

test("a blocked completion is reported once — not swallowed", () => {
  assert.match(complete, /if \(err instanceof SourceCompletionLost\) \{\s*(\/\/[^\n]*\n\s*)*await reportCompletionBlocked\(req\)\.catch\(\(\) => \{\}\);\s*return;/);
  const report = complete.slice(
    complete.indexOf("async function reportCompletionBlocked("),
    complete.indexOf("export async function completeSignatureRequest("),
  );
  // "Once" is atomic: lock the request row, check and write the event in that
  // transaction, and notify only if this caller wrote it. A bare findFirst →
  // create let two concurrent attempts both notify (review of #734).
  const claim = report.slice(report.indexOf("await prisma.$transaction(async (tx) => {"), report.indexOf("if (!claimed) return;"));
  assert.match(claim, /SELECT id FROM "SignatureRequest" WHERE id = \$\{req\.id\} AND "tenantId" IS NOT DISTINCT FROM \$\{req\.tenantId\}::text FOR UPDATE/);
  assert.match(claim, /tx\.signatureEvent\.findFirst\(\{\s*where: \{ requestId: req\.id, type: COMPLETION_BLOCKED_EVENT \}/);
  assert.match(claim, /if \(already\) return false;/);
  assert.match(claim, /tx\.signatureEvent\.create\(/);
  assert.doesNotMatch(report, /logSignEvent\(|prisma\.signatureEvent\./, "the event must be written inside the locked transaction");
  assert.ok(report.indexOf("if (!claimed) return;") < report.indexOf("sendPushToAll("), "push only after winning the claim");
  // Addressed to the request's own tenant: the signer's public link has no staff session.
  assert.match(report, /\{ tenantId: req\.tenantId \},/);
  // The signed-PDF cleanup still runs first, unchanged.
  const catchBlock = complete.slice(complete.indexOf("if (await signedPdfIsSafeToDelete(storedName, req.tenantId))"));
  assert.ok(catchBlock.indexOf("deleteFile(storedName)") < catchBlock.indexOf("reportCompletionBlocked(req)"));
});

test("the request page explains a blocked request with the same test completion uses", () => {
  const page = src("src/app/(app)/signatures/[id]/page.tsx");
  assert.match(page, /if \(allSigned && !isRequestClosed\(req\.status\)\) \{/);
  assert.match(page, /if \(!quote \|\| quote\.deletedAt\) blockedReason =/);
  assert.match(page, /else if \(quote\.supersededAt\) blockedReason =/);
  assert.match(page, /if \(!jobCard \|\| jobCard\.deletedAt\) blockedReason =/);
});

test("a completed request shows who never got their copy, with a resend", () => {
  const page = src("src/app/(app)/signatures/[id]/page.tsx");
  assert.match(page, /req\.status === "completed" \? req\.recipients\.filter\(\(r\) => r\.email && !r\.completedEmailSentAt\) : \[\]/);
  assert.match(page, /<SaveForm action=\{resendSignedCopies\.bind\(null, req\.id\)\}>/);
});

test("resend is access-checked, only for completed requests, and only to who is missing it", () => {
  const hub = src("src/app/actions/signhub.ts");
  const fn = hub.slice(hub.indexOf("export async function resendSignedCopies("), hub.indexOf("export async function remindRecipient("));
  assert.match(fn, /return asActionResult\(async \(\) => \{/);
  assert.match(fn, /await resolveSignatureRequestAccess\(/);
  assert.match(fn, /if \(req\.status !== "completed" \|\| !req\.signedPdfRef\) refuse\(/);
  // The shared fan-out — it skips anyone whose completedEmailSentAt is set.
  assert.match(fn, /await deliverCompletionEmails\(\{/);
  assert.match(fn, /tenantWhere: exactTenantWhere\(req\.tenantId\),/);
  // Fully delivered → the marker the recovery sweep looks for.
  assert.match(fn, /if \(delivery\.ok && !\(await prisma\.signatureEvent\.findFirst\(\{ where: \{ requestId, type: COMPLETED_EVENT \}/);
  assert.match(fn, /action: "signing\.signed_copy_resent"/);
});

test("the Signatures list surfaces both", () => {
  const list = src("src/app/(app)/signatures/page.tsx");
  assert.match(list, /events: \{ some: \{ type: COMPLETION_BLOCKED_EVENT \} \}/);
  assert.match(list, /recipients: \{ some: \{ email: \{ not: null \}, completedEmailSentAt: null \} \}/);
});
