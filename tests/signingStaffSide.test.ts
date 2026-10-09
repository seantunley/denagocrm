import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { endOfCalendarDay, quoteExpired } from "../src/lib/quoteExpiry";
import { accessibleRequestWhere, governingBinding, type RequestBinding } from "../src/lib/signing/binding";
import { CLOSED_REQUEST_STATUSES, isRequestClosed, lastValidDay } from "../src/lib/signing/statusPolicy";
import { AUTOMATIONS } from "../src/lib/automationRegister";

/**
 * The staff side of signing, after the review of 2026-10-09: what the quote's
 * card, the Signatures pages and their buttons do once a request has ended
 * without a signature — and when a link ends on its own.
 */

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
/** Code only — a rule that survives solely in a comment is not a rule. */
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── A link expires when its quote does ──────────────────────────────────────

test("a signing link's expiry is the instant its quote becomes expired", () => {
  // Johannesburg is UTC+2 all year: the end of 6 October there is 22:00 UTC.
  assert.equal(endOfCalendarDay(new Date("2026-10-06T10:00:00Z"), "Africa/Johannesburg").toISOString(), "2026-10-06T22:00:00.000Z");
  // The same rule, compared against the one the quote itself is judged by — in
  // zones either side of UTC, on the days their clocks change and on plain ones.
  for (const timeZone of ["Africa/Johannesburg", "America/New_York", "Pacific/Auckland", "Europe/London", "Australia/Lord_Howe"]) {
    for (const day of ["2026-03-08", "2026-03-29", "2026-04-05", "2026-09-27", "2026-10-04", "2026-10-06", "2026-10-25", "2026-11-01"]) {
      const validUntil = new Date(`${day}T12:00:00Z`);
      const expiry = endOfCalendarDay(validUntil, timeZone);
      assert.equal(quoteExpired(validUntil, timeZone, new Date(expiry.getTime() - 1)), false, `${timeZone} ${day}: still valid a millisecond before`);
      assert.equal(quoteExpired(validUntil, timeZone, expiry), true, `${timeZone} ${day}: expired at the instant`);
    }
  }
});

test("the date shown for a link is the last day it works, not the midnight after", () => {
  // Valid until 23 October in Johannesburg: the link stops at midnight, which is
  // already the 24th. Printed as a date, that instant said "expires 24 Oct".
  const expiresAt = endOfCalendarDay(new Date("2026-10-23T10:00:00Z"), "Africa/Johannesburg");
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(d);
  assert.equal(day(expiresAt), "2026-10-24");
  assert.equal(day(lastValidDay(expiresAt)), "2026-10-23");
  assert.equal(day(lastValidDay(expiresAt.toISOString())), "2026-10-23", "the card receives it serialised");
  const card = code("src/components/SigningBlock.tsx");
  assert.equal((card.match(/formatDate\(lastValidDay\(state\.expiresAt\)\)/g) ?? []).length, 2);
  assert.doesNotMatch(card, /formatDate\(state\.expiresAt\)/);
  assert.match(code("src/app/(app)/signatures/[id]/page.tsx"), /formatDate\(lastValidDay\(req\.expiresAt\)\)/);
});

test("the expiry is set where the request is created, from the quote read under its lock", () => {
  const start = code("src/app/actions/recordSigning.ts");
  assert.match(start, /linkExpiresAt = quoteLinkExpiry\(q\.validUntil, timeZone\);/);
  assert.ok(start.indexOf('SELECT id FROM "Quote" WHERE id = ${quoteId} FOR UPDATE') < start.indexOf("linkExpiresAt = quoteLinkExpiry("), "read after the lock that proves this is the version being sent");
  assert.match(start, /expiresAt: linkExpiresAt,/);
  const service = code("src/lib/signing/service.ts");
  assert.match(service, /expiresAt: opts\.expiresAt \?\? null,/, "written on the request the routes already check");
  // The routes have always refused a request past its expiry; nothing ever set one.
  for (const route of ["src/app/api/signing/[token]/route.ts", "src/app/api/signing/[token]/decline/route.ts"]) {
    assert.match(code(route), /expiresAt && (?:request|lockedRequest|recipient\.request)\.expiresAt < /, `${route} still refuses an expired link`);
  }
});

test("the sweep that closes expired requests is on the automatic-jobs page and names its tenant", () => {
  const cron = code("src/app/api/cron/automations/route.ts");
  assert.match(cron, /phase\(\s*"expired-signing-links",\s*\(\) => expireOverdueSigningRequests\(tenantId \?\? DEFAULT_TENANT_ID\)/);
  const housekeeping = AUTOMATIONS.find((a) => a.key === "signing-housekeeping");
  assert.ok(housekeeping?.phases?.includes("expired-signing-links"), "nothing runs hidden");
  assert.match(housekeeping?.does ?? "", /valid-until date has passed/);
  assert.equal(housekeeping?.reaches, "nobody", "it closes a request; it messages no one");

  const sweep = code("src/lib/signing/expiry.ts");
  for (const statement of ["signatureRequest.findMany", "signatureRecipient.findMany", "signatureRequest.updateMany"]) {
    const at = sweep.indexOf(statement);
    assert.ok(at !== -1, statement);
    assert.match(sweep.slice(at, at + 220), /tenantId/, `${statement} names the tenant`);
  }
  // Quote first, then the request — the order every other signing transaction takes.
  assert.ok(sweep.indexOf('FROM "Quote"') < sweep.indexOf('FROM "SignatureRequest"'));
  assert.match(sweep, /signers\.every\(\(signer\) => signer\.status === "signed"\)\) return false;/, "a request everyone signed is a completion, never an expiry");
});

// ── Every closed state is closed everywhere ─────────────────────────────────

test("the quote's card treats all five closed states as closed", () => {
  const card = code("src/components/SigningBlock.tsx");
  assert.match(card, /const active = Boolean\(state\) && !isRequestClosed\(state!\.status\);/);
  assert.doesNotMatch(card, /status !== "completed" && state\.status !== "declined" && state\.status !== "voided"/, "the hand-written list left out rejected and expired");
  for (const status of ["completed", "declined", "voided", "expired", "rejected"]) assert.ok(isRequestClosed(status), status);
  assert.equal(CLOSED_REQUEST_STATUSES.length, 5);
  // Each unsigned ending says what happened and why.
  assert.match(card, /state\?\.status === "rejected"/);
  assert.match(card, /state\?\.status === "expired"/);
  assert.match(card, /Not approved/);
  assert.match(card, /The signing link expired/);
  assert.doesNotMatch(card, /Void the request below and send a fresh one/, "a closed request has no Void button to press");
});

test("the card is told why a request was rejected and when its link expires", () => {
  const record = code("src/lib/signing/record.ts");
  assert.match(record, /approvals: \{ where: \{ status: "rejected" \}, orderBy: \{ decidedAt: "desc" \}, take: 1 \}/);
  assert.match(record, /expiresAt: req\.expiresAt,/);
  assert.match(record, /const rejected = req\.status === "rejected" \? req\.approvals\[0\] : undefined;/);
});

test("the Signatures request page shows no button that cannot work", () => {
  const page = code("src/app/(app)/signatures/[id]/page.tsx");
  assert.match(page, /const closed = isRequestClosed\(req\.status\);/);
  assert.doesNotMatch(page, /const closed = req\.status === "completed" \|\| req\.status === "voided"/);
  assert.match(page, /<SendVoidBar requestId=\{req\.id\} status=\{req\.status\} closed=\{closed\} \/>/);
  const client = code("src/app/(app)/signatures/[id]/SigningClient.tsx");
  assert.doesNotMatch(client, /status === "completed" \|\| status === "voided"/, "the client must not keep its own, shorter, idea of closed");
  // What it is a signature on, why it was declined, how each signer was checked.
  assert.match(page, /href=\{`\/quotes\/\$\{linkedQuote\.id\}`\}/);
  assert.match(page, /r\.status === "declined" && \(/);
  assert.match(page, /r\.declineReason\?\.trim\(\)/);
  assert.match(page, /IDENTITY_MODE\[req\.identityMode\]/);
});

// ── Access ──────────────────────────────────────────────────────────────────

test("the request page checks the record, not just the Signatures permission", () => {
  const page = code("src/app/(app)/signatures/[id]/page.tsx");
  assert.match(page, /if \(!\(await canAccessSignatureRequest\(user, req\)\)\) notFound\(\);/);
  assert.ok(page.indexOf("canAccessSignatureRequest(user, req)") < page.indexOf("return ("), "decided before anything is rendered");
  const list = code("src/app/(app)/signatures/page.tsx");
  assert.match(list, /const mine = await accessibleSignatureRequestWhere\(user\);/);
  // Every query the list and its counts are built from.
  assert.equal((list.match(/AND: \[mine\]/g) ?? []).length, 4, "status counts, completion times, the list itself and Needs attention");
  assert.doesNotMatch(list, /\.\.\.mine/, "a spread would be overwritten by a query's own OR");
  assert.match(list, /allPendingApprovals\.filter\(\(step\) => canActOnStep\(step, user\)\)/);
});

/** Evaluate the Prisma-shaped filter against a row, for the handful of operators it uses. */
function matches(where: ReturnType<typeof accessibleRequestWhere>, row: RequestBinding): boolean {
  const field = (cond: unknown, value: string | null) => {
    if (cond === null) return value === null;
    if (typeof cond === "string") return value === cond;
    const c = cond as { in?: string[]; not?: null };
    if ("in" in c) return value !== null && c.in!.includes(value);
    return value !== null; // { not: null }
  };
  return where.OR.some((branch) => Object.entries(branch).every(([key, cond]) => field(cond, row[key as keyof RequestBinding])));
}

test("the list filter is the same precedence as the single-record check, never a looser one", () => {
  const row = (binding: Partial<RequestBinding>): RequestBinding => ({ quoteId: null, jobCardId: null, contactId: null, documentId: null, createdById: null, ...binding });
  const mine = accessibleRequestWhere({ quoteIds: ["q_mine"], jobCardIds: ["j_mine"], documentIds: ["d_mine"], contactIds: ["c_mine"], userId: "me" });

  assert.equal(matches(mine, row({ quoteId: "q_mine", contactId: "c_other" })), true, "my quote, whoever the customer is");
  // THE case the precedence exists for: somebody else's quote, for a customer and a document I can see.
  assert.equal(matches(mine, row({ quoteId: "q_other", contactId: "c_mine", documentId: "d_mine" })), false);
  assert.equal(matches(mine, row({ jobCardId: "j_other", contactId: "c_mine" })), false, "the same for a job card");
  assert.equal(matches(mine, row({ jobCardId: "j_mine" })), true);
  assert.equal(matches(mine, row({ documentId: "d_mine" })), true);
  assert.equal(matches(mine, row({ contactId: "c_mine" })), true, "a contact decides only when nothing above it is bound");
  assert.equal(matches(mine, row({ createdById: "me" })), true, "bound to nothing: its creator's");
  assert.equal(matches(mine, row({ createdById: "someone" })), false);

  // It agrees with governingBinding on which record decides, for every combination.
  const ids = { quoteId: ["q_mine", "q_other", null], jobCardId: ["j_mine", "j_other", null], documentId: ["d_mine", "d_other", null], contactId: ["c_mine", "c_other", null] } as const;
  for (const quoteId of ids.quoteId) for (const jobCardId of ids.jobCardId) for (const documentId of ids.documentId) for (const contactId of ids.contactId) {
    const r = row({ quoteId, jobCardId, documentId, contactId, createdById: "someone" });
    const governing = governingBinding(r);
    const expected = governing ? governing.id.endsWith("_mine") : false;
    assert.equal(matches(mine, r), expected, JSON.stringify(r));
  }

  // "Every record of that kind" stays every record — and still only when it governs.
  const unrestrictedQuotes = accessibleRequestWhere({ quoteIds: null, jobCardIds: [], documentIds: [], contactIds: [], userId: "me" });
  assert.equal(matches(unrestrictedQuotes, row({ quoteId: "anything" })), true);
  assert.equal(matches(unrestrictedQuotes, row({ jobCardId: "j_other" })), false);
});

// ── One Void, and sends that respect whose turn it is ───────────────────────

test("both Void buttons run the same transaction, and it takes the quote back with it", () => {
  const shared = code("src/lib/signing/void.ts");
  assert.ok(shared.indexOf('FROM "Quote"') < shared.indexOf("tx.signatureRequest.updateMany"), "source record locked before the request");
  assert.match(shared, /where: \{ id: requestId, tenantId, status: \{ notIn: \[\.\.\.CLOSED_REQUEST_STATUSES\] \} \},\s*data: \{ status: "voided" \}/);
  assert.match(shared, /where: \{ id: quoteId, tenantId, status: "sent", signedAt: null \}, data: \{ status: "draft" \}/);
  for (const file of ["src/app/actions/signhub.ts", "src/app/actions/recordSigning.ts"]) {
    const actions = code(file);
    assert.match(actions, /await voidOpenRequest\(/, `${file} uses the shared void`);
    assert.doesNotMatch(actions, /data: \{ status: "voided" \}/, `${file} must not keep a void of its own`);
  }
});

test("a workflow's request is sent, resent and reminded only to whoever it is waiting on", () => {
  const hub = code("src/app/actions/signhub.ts");
  const send = hub.slice(hub.indexOf("export async function sendRequest("), hub.indexOf("export async function resendRequest("));
  const resend = hub.slice(hub.indexOf("export async function resendRequest("), hub.indexOf("export async function resendSignedCopies("));
  const remind = hub.slice(hub.indexOf("export async function remindRecipient("), hub.indexOf("export async function voidRequest("));
  for (const [name, body] of [["send", send], ["resend", resend]] as const) {
    assert.match(body, /if \(req\.workflowGraphJson\) \{/, `${name} asks the workflow`);
    assert.match(body, /const recipient = await nextSigner\(requestId\);/, name);
    assert.match(body, /await pendingApprovalNode\(requestId\)/, `${name} knows an approval has no recipient`);
    // Order-based dispatch only for a request with no workflow.
    const orderBased = body.indexOf("dispatchRequest(requestId");
    assert.ok(orderBased > body.indexOf("} else {"), `${name}: dispatchRequest only in the non-workflow branch`);
  }
  assert.match(send, /await advanceWorkflow\(requestId\);/, "a first send raises the approval, as the quote's own card does");
  assert.doesNotMatch(resend, /advanceWorkflow/, "a resend never moves the workflow on");
  assert.match(remind, /r\.request\.workflowGraphJson \|\| r\.request\.ordering === "sequential"/);
  assert.match(remind, /if \(next\?\.id !== r\.id\) \{\s*return \{ ok: false,/);
  // One definition of "who is up", in a module every sender can import.
  assert.doesNotMatch(code("src/app/actions/recordSigning.ts"), /async function nextSigner\(/);
  assert.match(code("src/lib/signing/nextSigner.ts"), /nodeId: request\.currentNodeId/);
});

// ── The customer who can only be reached by WhatsApp ────────────────────────

test("a lead's mobile reaches the signer without needing an email as well", () => {
  const service = code("src/lib/signing/service.ts");
  assert.match(service, /const fallbackPhone = opts\.customer\?\.phone \? normalizePhone\(opts\.customer\.phone\) : null;/);
  assert.match(service, /\?\? fallbackPhone;/);
  assert.match(service, /recipient\.party === "customer" \|\|/, "the customer's own row gets it, by party");
  const start = code("src/app/actions/recordSigning.ts");
  assert.match(start, /customer: \{ email: envelope\.customerEmail, phone: envelope\.customerPhone \},/);
  assert.doesNotMatch(start, /if \(envelope\.customerPhone && envelope\.customerEmail\)/, "the number used to be copied only when an email existed too");
});

// ── Wording that matches what happens ───────────────────────────────────────

test("the card never claims a countersignature the layout may not have", () => {
  // "Countersign & review" and "Countersign in one click" stood on every quote,
  // including the ones whose layout has only the customer's signature block.
  // Whether we sign is the layout's decision, so the start button prepares and
  // opens the document, and the review window — which knows whose turn it is —
  // is the only place that offers to countersign.
  const card = code("src/components/SigningBlock.tsx");
  assert.doesNotMatch(card, /Countersign & review|Countersign in one click/);
  const start = card.slice(card.indexOf('run("start"'), card.indexOf('busy === "start"'));
  assert.match(start, /startRecordSigning\(/);
  assert.doesNotMatch(start, /countersignRecord/, "the start click signs nothing");
  assert.match(card, /onCountersign=\{\(\) => run\("countersign", \(\) => countersignRecord\(kind, id\)\)\}/, "countersigning is its own step, in the review");
  const preview = code("src/components/signing/SignedDocPreview.tsx");
  assert.match(preview, /const awaitingMe = view\.next\?\.isMe \?\? false;/);
  assert.match(preview, /\{awaitingMe \? \(\s*<button className="btn-primary" disabled=\{busy !== null\} onClick=\{onCountersign\}>/);

  // …and the editor says "Out for signature" only once it has gone out.
  const editor = code("src/components/quotes/QuoteEditorDialog.tsx");
  assert.match(editor, /signing\.state\?\.sentAt\s*\? "Out for signature — void the request below to edit\."\s*: "A signing document is open but has not been sent — discard it below to edit\."/);
});

test("the Signatures page no longer points at an option that was removed", () => {
  const list = code("src/app/(app)/signatures/page.tsx");
  assert.doesNotMatch(list, /Open a document in the editor and choose|href="\/documents"/);
  assert.match(list, /Open a quote or a job card and use its Online signature card\./);
});
