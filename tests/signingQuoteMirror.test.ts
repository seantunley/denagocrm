import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

// Production, Oct 2026: Q-1022 went out from the signing hub and the customer
// opened it, yet the quote stayed "draft" and never viewed — so the gone-quiet
// nudge, lead score, attention list, dashboard and DAX all read it as unsent.
// Emailing a quote marks it sent; voiding a hub request drops it back to draft;
// the hub's own send and open now do their half.
const mirror = code("src/lib/signing/quoteMirror.ts");

test("only the CUSTOMER receiving or opening it counts — not an approver, viewer or staff countersigner", () => {
  assert.match(mirror, /if \(r\.role !== "signer"\) return false;/);
  // Exact, case-folded match — an ILIKE would read "_" and "%" in an address as wildcards —
  // then membership of THIS request's tenant only (behaviour: signingQuoteMirrorTenant.test.ts).
  assert.match(mirror, /const userIds = await ciExactIds\("userEmail", email\);/);
  assert.match(mirror, /basePrisma\.tenantMember\.findFirst\(\{ where: \{ tenantId, userId: \{ in: userIds \} \}/);
  assert.equal((mirror.match(/isCustomerSigner\(recipient, tenantId\)/g) ?? []).length, 2);
});

test("sent: a draft only, never a signed, superseded or deleted quote — always in the request's own tenant", () => {
  assert.match(mirror, /where: \{ id: quoteId, tenantId, status: "draft", deletedAt: null, signedAt: null, supersededAt: null \},\s*data: \{ status: "sent" \}/);
  assert.match(mirror, /where: \{ id: quoteId, tenantId, viewedAt: null, deletedAt: null \}, data: \{ viewedAt: new Date\(\) \}/, "the FIRST open, never moved later");
  assert.match(mirror, /SELECT id FROM "Quote" WHERE id = \$\{quoteId\} AND "tenantId" = \$\{tenantId\} FOR UPDATE/);
  assert.match(mirror, /where: \{ id: requestId, tenantId, quoteId, status: \{ notIn: \[\.\.\.CLOSED_REQUEST_STATUSES\] \} \}/);
  assert.equal((mirror.match(/if \(!quoteId \|\| !tenantId\) return;/g) ?? []).length, 2, "no tenant, nothing written");
});

test("a void can't be undone: quote locked first (void's order), and only while the request is still open", () => {
  const guard = mirror.slice(mirror.indexOf("async function whileRequestOpen"));
  const lock = guard.indexOf('SELECT id FROM "Quote" WHERE id = ${quoteId} AND "tenantId" = ${tenantId} FOR UPDATE');
  const check = guard.indexOf("status: { notIn: [...CLOSED_REQUEST_STATUSES] }");
  const write = guard.indexOf("if (open) await write(tx);");
  assert.ok(lock > 0 && lock < check && check < write);
  // …the same order voiding uses: the quote, then the request.
  const voidPath = code("src/app/actions/recordSigning.ts");
  assert.match(voidPath, /if \(kind === "quote"\) await tx\.\$executeRaw`SELECT id FROM "Quote" WHERE id = \$\{id\} FOR UPDATE`;[\s\S]{0,200}tx\.signatureRequest\.updateMany/);
});

test("it never costs the send or the open", () => {
  assert.equal((mirror.match(/\} catch \(error\) \{\s*(?:\/\/[^\n]*\n\s*)?await logError\("signing"/g) ?? []).length, 2);
});

test("wired where the hub sends (first send, actually delivered — not a reminder) and where it records the first open", () => {
  const dispatch = code("src/lib/signing/dispatch.ts");
  const notify = dispatch.slice(dispatch.indexOf("export async function notifyRecipient"), dispatch.indexOf("export async function dispatchRequest"));
  assert.match(notify, /\} else \{[\s\S]*?status: delivered \? "sent" : "pending"[\s\S]*?if \(delivered\) await mirrorQuoteSent\(\{ tenantId: r\.request\.tenantId, quoteId: r\.request\.quoteId, requestId: r\.requestId \}, r\);\s*\}/);
  const events = code("src/lib/signing/events.ts");
  const view = events.slice(events.indexOf("export async function recordView"));
  assert.match(view, /if \(r\?\.viewedAt\) return;[\s\S]*if \(r\) await mirrorQuoteViewed\(\{ tenantId: r\.request\.tenantId, quoteId: r\.request\.quoteId, requestId \}, r\);/, "after the once-only guard");
});

test("DAX reads the customer's own messages and activities, not the customer's OTHER leads", () => {
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /const theirs = \{ OR: \[\{ leadId: lead\.id \}, \.\.\.\(lead\.contactId \? \[\{ contactId: lead\.contactId, leadId: null \}\] : \[\]\)\] \};/);
  assert.match(lib, /prisma\.communication\.findMany\(\{\s*where: theirs,/);
  assert.match(lib, /prisma\.activity\.findMany\(\{\s*where: theirs,/);
  // Last contact counts them too — real contact only.
  assert.match(lib, /prisma\.communication\.groupBy\(\{ by: \["contactId"\], where: \{ contactId: \{ in: contactIds \}, leadId: null, \.\.\.contactCommunicationWhere \}/);
  assert.match(lib, /prisma\.activity\.groupBy\(\{ by: \["contactId"\], where: \{ contactId: \{ in: contactIds \}, leadId: null, \.\.\.contactActivityWhere \}/);
});
