import { basePrisma } from "../src/lib/db";

/**
 * Backfill the rows `check-production.ts` reports as tenantless.
 *
 *   npx tsx scripts/backfill-tenantless-rows.ts            # DRY RUN (default)
 *   npx tsx scripts/backfill-tenantless-rows.ts --apply    # writes
 *
 * DRY RUN IS THE DEFAULT AND `--apply` IS THE ONLY WAY PAST IT. This writes to
 * live business data, so the plan is printable, reviewable and identical to what
 * `--apply` then executes — the dry run builds the exact same list and simply
 * stops before the UPDATE.
 *
 * ── Why every value is DERIVED, never defaulted ─────────────────────────────
 *
 * There is one tenant today, so `tenantId = DEFAULT_TENANT_ID` would produce the
 * same answer in every case and would be wrong anyway: it is the "confident,
 * wrong owner" this codebase's own actingTenant.ts calls the worse direction. A
 * row stamped by a guess reads as correct to every later query. So each row is
 * resolved from the record it is ABOUT — the lead, the contact, the signature
 * request, the quote, the parent of the document — and a row whose source cannot
 * be resolved is REPORTED AND SKIPPED rather than guessed at.
 *
 * That also means this script stays correct once there are two tenants, which
 * matters because it will be re-run.
 *
 * ── What is deliberately NOT touched ────────────────────────────────────────
 *
 * `platform_admin` AuditEvents (6 on production). Those are platform actions
 * ACROSS tenants and have no owning workspace; #508 classifies them as expected
 * global attribution and the preflight warns rather than fails. Stamping them
 * would invent attribution to quiet a checker that is not complaining.
 */

const APPLY = process.argv.includes("--apply");

type Plan = { table: string; id: string; tenantId: string; why: string };
type Skip = { table: string; id: string; why: string };

const plans: Plan[] = [];
const skips: Skip[] = [];

/** Resolve one record's tenantId, or null when the row or its tenant is absent. */
async function tenantOf(table: string, id: string | null): Promise<string | null> {
  if (!id) return null;
  const rows = await basePrisma.$queryRawUnsafe<{ tenantId: string | null }[]>(
    `SELECT "tenantId" FROM "${table}" WHERE "id" = $1`,
    id,
  );
  return rows[0]?.tenantId ?? null;
}

/**
 * AuditEvent — resolved from the entity the event is ABOUT.
 *
 * `entityType` is written by writeAudit and is the authoritative pointer;
 * `entityId` is the row. The map is explicit rather than derived from the type
 * name so a typo produces a skip, not a query against a table that happens to
 * exist. Note `quote` is lower-case in the data (one caller passes it that way),
 * which is exactly the kind of thing a derived mapping would silently miss.
 */
const AUDIT_ENTITY_TABLE: Record<string, string> = {
  Lead: "Lead",
  Contact: "Contact",
  TestDriveBooking: "TestDriveBooking",
  SignatureRequest: "SignatureRequest",
  quote: "Quote",
  Quote: "Quote",
  Document: "Document",
  JobCard: "JobCard",
};

/**
 * AUDITEVENT CANNOT BE BACKFILLED, AND MUST NOT BE.
 *
 * `AuditEvent_no_update` (BEFORE UPDATE, FOR EACH ROW, `prevent_audit_event_mutation()`)
 * refuses every UPDATE unconditionally, with `AuditEvent is append-only`. Its
 * sibling `AuditEvent_no_delete` does the same for DELETE. That is the correct
 * guarantee for an append-only audit stream and it is doing exactly its job:
 * this script tried to rewrite history and the database said no.
 *
 * The first version of this script planned 18 AuditEvent updates alongside the
 * Document and the UserSession, and because all 20 shared ONE transaction the
 * trigger rolled the whole thing back — including the two rows that would have
 * succeeded. Nothing was half-applied, which is the one thing that had to hold.
 *
 * Suspending the trigger for a "scoped repair" is available and is the wrong
 * trade: disabling an integrity guarantee on live audit data to make a checker
 * green inverts what the checker is for.
 *
 * So these rows stay as they are. They are finite (18), historical, and #507
 * stopped the producer that made them — the preflight's job is to accept a
 * bounded immutable legacy set and keep failing on anything NEWER, not to demand
 * a write the database is built to refuse. That rule is a separate change.
 */
const AUDIT_EVENT_IS_APPEND_ONLY = true;

async function planAuditEvents() {
  if (AUDIT_EVENT_IS_APPEND_ONLY) return;
  const rows = await basePrisma.$queryRaw<
    { id: string; actorType: string | null; entityType: string | null; entityId: string | null }[]
  >`
    SELECT "id", "actorType", "entityType", "entityId"
    FROM "AuditEvent"
    WHERE "tenantId" IS NULL AND "actorType" IS DISTINCT FROM 'platform_admin'
      AND "actorType" IS DISTINCT FROM 'system_global'
    ORDER BY "createdAt"
  `;
  for (const row of rows) {
    const table = row.entityType ? AUDIT_ENTITY_TABLE[row.entityType] : undefined;
    if (!table) {
      skips.push({ table: "AuditEvent", id: row.id, why: `entityType "${row.entityType}" has no mapping` });
      continue;
    }
    const tenantId = await tenantOf(table, row.entityId);
    if (!tenantId) {
      skips.push({
        table: "AuditEvent",
        id: row.id,
        why: `${table} ${row.entityId} is missing or itself tenantless`,
      });
      continue;
    }
    plans.push({ table: "AuditEvent", id: row.id, tenantId, why: `${row.entityType} ${row.entityId}` });
  }
}

/** Document — the parent it is filed against, exactly as replaceDocument now resolves it. */
async function planDocuments() {
  const rows = await basePrisma.$queryRaw<
    { id: string; contactId: string | null; vehicleId: string | null; jobCardId: string | null; quoteId: string | null }[]
  >`
    SELECT "id", "contactId", "vehicleId", "jobCardId", "quoteId"
    FROM "Document" WHERE "tenantId" IS NULL AND "deletedAt" IS NULL
  `;
  for (const row of rows) {
    const parents: [string, string | null][] = [
      ["Contact", row.contactId],
      ["Vehicle", row.vehicleId],
      ["JobCard", row.jobCardId],
      ["Quote", row.quoteId],
    ];
    let resolved: { tenantId: string; why: string } | null = null;
    for (const [table, id] of parents) {
      if (!id) continue;
      const tenantId = await tenantOf(table, id);
      if (tenantId) {
        resolved = { tenantId, why: `${table} ${id}` };
        break;
      }
    }
    if (!resolved) {
      skips.push({ table: "Document", id: row.id, why: "no parent record resolves a tenant" });
      continue;
    }
    plans.push({ table: "Document", id: row.id, ...resolved });
  }
}

/** UserSession — the session's own user decides; nothing else can. */
async function planUserSessions() {
  const rows = await basePrisma.$queryRaw<{ id: string; userId: string; revokedAt: Date | null }[]>`
    SELECT "id", "userId", "revokedAt" FROM "UserSession" WHERE "tenantId" IS NULL
  `;
  for (const row of rows) {
    const tenantId = await tenantOf("User", row.userId);
    if (!tenantId) {
      skips.push({ table: "UserSession", id: row.id, why: `User ${row.userId} has no tenantId` });
      continue;
    }
    plans.push({
      table: "UserSession",
      id: row.id,
      tenantId,
      why: `User ${row.userId}${row.revokedAt ? " (already revoked — cannot be used either way)" : ""}`,
    });
  }
}

async function main() {
  await planAuditEvents();
  await planDocuments();
  await planUserSessions();

  console.log(`\n${APPLY ? "APPLYING" : "DRY RUN — nothing will be written"}\n`);
  const byTable = new Map<string, Plan[]>();
  for (const p of plans) byTable.set(p.table, [...(byTable.get(p.table) ?? []), p]);
  for (const [table, rows] of byTable) {
    console.log(`${table} — ${rows.length} row(s)`);
    for (const r of rows) console.log(`  ${r.id}  →  ${r.tenantId}   (from ${r.why})`);
    console.log();
  }

  if (skips.length > 0) {
    console.log(`SKIPPED — no owner could be DERIVED, and none will be invented:`);
    for (const s of skips) console.log(`  ${s.table} ${s.id} — ${s.why}`);
    console.log();
  }

  if (!APPLY) {
    console.log(`Would update ${plans.length} row(s). Re-run with --apply to write.`);
    return;
  }

  // One transaction: either the whole cleanup lands or none of it does, so a
  // failure halfway cannot leave the preflight reporting a different number than
  // the plan just printed.
  await basePrisma.$transaction(async (tx) => {
    for (const p of plans) {
      await tx.$executeRawUnsafe(
        `UPDATE "${p.table}" SET "tenantId" = $1 WHERE "id" = $2 AND "tenantId" IS NULL`,
        p.tenantId,
        p.id,
      );
    }
  });
  console.log(`Updated ${plans.length} row(s). Re-run scripts/check-production.ts to confirm.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(2);
  })
  .finally(() => basePrisma.$disconnect());
