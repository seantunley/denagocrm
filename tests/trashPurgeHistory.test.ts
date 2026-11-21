import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The 60-day trash purge (2026-11-21): it had failed silently since 2026-07-27, when composite tenant FKs with no delete
 * rule landed on loose history columns. History is now unlinked on delete; paperwork keeps its record in the trash; a
 * failure is logged, never swallowed. Real-DB proof: scripts/test-trash-purge.ts.
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const sql = code("prisma/migrations/20261121100000_purge_history_links_set_null/migration.sql");

test("history links are cleared on delete — that column only, the workspace kept, same constraint", () => {
  const links: Array<[string, string, string]> = [
    ["AuditLog", "contactId", "Contact"], ["AuditLog", "leadId", "Lead"],
    ["SurveyResponse", "contactId", "Contact"], ["SurveyResponse", "leadId", "Lead"], ["SurveyResponse", "jobCardId", "JobCard"],
    ["StockEvent", "leadId", "Lead"], ["StockEvent", "quoteId", "Quote"],
    ["Fleet", "contactId", "Contact"], ["WarrantyClaim", "contactId", "Contact"], ["WarrantyClaim", "jobCardId", "JobCard"],
    ["Campaign", "productId", "Product"],
  ];
  for (const [table, column, parent] of links) {
    const name = `${table}_tenantId_${column}_fkey`;
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}"\\s+FOREIGN KEY \\("tenantId", "${column}"\\) REFERENCES "${parent}"\\("tenantId", "id"\\) ON DELETE SET NULL \\("${column}"\\) NOT VALID;`), name);
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" VALIDATE CONSTRAINT "${name}";`), `${name} validated`);
  }
  // Paperwork keeps its no-delete rule.
  assert.doesNotMatch(sql, /ADD CONSTRAINT "(SignatureRequest|DocInstance|Document|LegalArtifact)_/);
});

test("the purge leaves a record with paperwork in the trash, and logs a failure instead of swallowing it", () => {
  const trash = code("src/lib/trash.ts");
  assert.match(trash, /contact: \[\["Document", "contactId"\], \["DocInstance", "contactId"\], \["SignatureRequest", "contactId"\]\],/);
  assert.match(trash, /quote: \[\["Document", "quoteId"\], \["DocInstance", "quoteId"\], \["SignatureRequest", "quoteId"\]\],/);
  assert.match(trash, /const ids = locked\.map\(\(r\) => r\.id\)\.filter\(\(id\) => !kept\.has\(id\)\);/);
  assert.match(trash, /\} catch \(err\) \{[\s\S]{0,400}await logError\("trash-purge", err, `\$\{model\}: purge failed;/);
  assert.doesNotMatch(trash, /\} catch \{\s*\/\/ parent \+ children \+ custom values roll back together; nothing purged\s*continue;/);
  assert.match(code(".github/workflows/security-rbac-ci.yml"), /run: npm run test:trash-purge/);
});
