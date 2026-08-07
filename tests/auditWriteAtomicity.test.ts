import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.join(__dirname, "..", p), "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * A governance write and its audit commit together, or neither does.
 *
 * PRODUCTION, 2026-08-07. Creating a lead wrote the row, then wrote the audit,
 * then threw when the audit failed. The lead was already committed, so the
 * operator was told the save failed for work that had succeeded — and the retry
 * made a second lead. The delete path had the identical shape, which is why
 * clearing the duplicate also reported failure and then "not found".
 *
 * The particular audit failure has its own fix. This guards the SHAPE, because
 * any future audit failure — a constraint, a timeout, a dropped connection —
 * reproduces the same duplicate through the same two-commit sequence.
 *
 * `logAuditStrict` has always taken a transaction. Nothing was passing it one.
 */

test("the strict lead audit runs inside the transaction that creates the lead", () => {
  const source = stripComments(read("src/lib/leadCreate.ts"));

  // The row and the audit in ONE transaction…
  assert.match(source, /await prisma\.\$transaction\(async \(tx\) => \{/);
  assert.match(source, /const created = await tx\.lead\.create\(\{ data \}\)/);
  assert.match(source, /await logAuditStrict\(auditFor\(created\), tx\)/);

  // …and never the old sequence, where the create resolved before the audit
  // was even attempted.
  assert.doesNotMatch(source, /await logAuditStrict\(entry\);/);
});

test("a best-effort audit stays OUTSIDE the transaction", () => {
  const source = stripComments(read("src/lib/leadCreate.ts"));

  // logAudit swallows its own error. Swallowing an error inside a transaction is
  // worse than not catching it: PostgreSQL has already aborted the transaction,
  // so every later statement fails and the commit dies anyway — turning a
  // best-effort audit into a lost lead.
  assert.match(source, /if \(!input\.audit\.strict\) await logAudit\(auditFor\(lead\)\)/);
  assert.doesNotMatch(source, /logAudit\([^)]*, tx\)/);
});

test("the delete and its audit commit together", () => {
  const source = stripComments(read("src/app/actions/leads.ts"));
  const remove = source.slice(source.indexOf("export async function deleteLead"));

  assert.match(remove, /await basePrisma\.\$transaction\(async \(tx\) => \{/);
  assert.match(remove, /softDeleteRecord\("lead", leadId, reason, user\.name, tx\)/);
  assert.match(remove, /\}, tx\);/, "the audit must join that transaction");
  // The refusal moved OUTSIDE the transaction: returning null rolls nothing back
  // because nothing was written, and throwing inside would be indistinguishable
  // from a genuine failure.
  assert.match(remove, /if \(!lead\) refuse\("That lead could not be found\."\);/);
});

test("softDeleteRecord can join a caller's transaction", () => {
  const source = stripComments(read("src/lib/trash.ts"));
  // Shared by every trash-able model, so one parameter closes the same gap for
  // contacts, quotes, vehicles and the rest rather than for leads alone.
  assert.match(source, /function delegate\(model: TrashModel, client: any = basePrisma\)/);
  assert.match(source, /delegate\(model, tx\)\.updateMany/);
  assert.match(source, /delegate\(model, tx\)\.findFirst/);
});

test("the audit transaction type admits both clients", () => {
  const source = stripComments(read("src/lib/audit.ts"));
  // Typing this from basePrisma alone excluded the SCOPED client's transaction,
  // which is what the CRM actions use — so a caller that kept its tenant guard
  // could not hand over its transaction, and was pushed back to auditing after
  // the commit. The type must not be what reopens the gap it exists to close.
  assert.match(source, /type BaseTx = /);
  assert.match(source, /type ScopedTx = /);
  assert.match(source, /type AuditTx = BaseTx \| ScopedTx;/);
});

test("a contact already on file is reused instead of duplicated", () => {
  const source = stripComments(read("src/app/actions/leads.ts"));
  // The old guard reused a contact only when its tenantId was NULL — a
  // workaround for the same composite foreign key. Every backfilled contact
  // therefore failed the test, so creating a lead for an existing customer
  // quietly made a second contact for them.
  assert.doesNotMatch(source, /const canReuse = existing && \(existing\.tenantId === null\)/);
  assert.match(source, /if \(existing\) \{\s*data\.contactId = existing\.id;/);
});
