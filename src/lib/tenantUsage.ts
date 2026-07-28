import "server-only";

import { basePrisma } from "@/lib/db";

/**
 * Per-tenant usage ESTIMATES for the platform console.
 *
 * ── Storage ────────────────────────────────────────────────────────────────
 * Postgres reports size per TABLE, never per tenant, so a tenant's footprint
 * cannot be measured directly. This apportions each table's real on-disk size by
 * the tenant's SHARE OF ROWS in it:
 *
 *     estimate = Σ  table_bytes × (tenant_rows / total_rows)
 *
 * It is a guesstimate and is labelled as one. Known ways it is wrong:
 *   - Rows are assumed to be of average size. A tenant whose rows carry big text
 *     (long notes, stack traces, JSON blobs) uses more than its row share; one
 *     with sparse rows uses less.
 *   - Table size includes indexes and dead tuples not yet vacuumed.
 *   - Soft-deleted rows still occupy space and are counted, which is correct for
 *     storage even though the UI hides them elsewhere.
 * Accurate per-row accounting (`pg_column_size` over every row) would be exact and
 * far too expensive to run on a page load, so it is deliberately not used.
 *
 * Only the largest tables are sampled: the tail contributes little and would cost
 * a query each. What is omitted is stated in the return value rather than hidden.
 *
 * ── Traffic ────────────────────────────────────────────────────────────────
 * There is NO request or bandwidth logging in this application, so HTTP traffic
 * genuinely cannot be estimated from the database — inventing a number would be
 * worse than saying so. What IS recorded is business activity, which is usually
 * the question people actually mean: messages sent, records created, sessions.
 */

/** How many of the biggest tables to apportion. */
const SAMPLED_TABLES = 12;

export type TenantStorage = {
  estimatedBytes: number;
  /** Per-table contributions, largest first, for showing the working. */
  breakdown: { table: string; bytes: number; rows: number; sharePct: number }[];
  /** Tables excluded from the sample (the long tail). */
  tablesOmitted: number;
};

export type TenantActivity = {
  communications30d: number;
  leadsCreated30d: number;
  contactsCreated30d: number;
  activities30d: number;
  auditEvents30d: number;
  sessions30d: number;
};

type TableSize = { table_name: string; bytes: bigint; has_tenant: boolean };

/**
 * Biggest tables and whether they carry a tenantId, in ONE query. `pg_class` is
 * consulted directly because pg_total_relation_size is the only honest source of
 * on-disk size.
 */
async function largestTenantTables(): Promise<TableSize[]> {
  return basePrisma.$queryRaw<TableSize[]>`
    SELECT c.relname::text AS table_name,
           pg_total_relation_size(c.oid) AS bytes,
           EXISTS (
             SELECT 1 FROM information_schema.columns col
             WHERE col.table_schema = 'public'
               AND col.table_name = c.relname
               AND col.column_name = 'tenantId'
           ) AS has_tenant
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC
  `;
}

export async function getTenantStorage(tenantId: string): Promise<TenantStorage> {
  const all = await largestTenantTables();
  const scoped = all.filter((t) => t.has_tenant);
  const sampled = scoped.slice(0, SAMPLED_TABLES);

  const breakdown: TenantStorage["breakdown"] = [];
  let estimatedBytes = 0;

  for (const table of sampled) {
    const bytes = Number(table.bytes);
    if (bytes === 0) continue;

    // Table names come from pg_class, never from user input, so interpolating the
    // identifier here cannot be injection — but it is quoted regardless.
    const [counts] = await basePrisma.$queryRawUnsafe<{ mine: bigint; total: bigint }[]>(
      `SELECT count(*) FILTER (WHERE "tenantId" = $1)::bigint AS mine,
              count(*)::bigint AS total
       FROM "${table.table_name}"`,
      tenantId,
    );

    const mine = Number(counts?.mine ?? 0);
    const total = Number(counts?.total ?? 0);
    if (total === 0 || mine === 0) continue;

    const share = mine / total;
    const attributed = Math.round(bytes * share);
    estimatedBytes += attributed;
    breakdown.push({
      table: table.table_name,
      bytes: attributed,
      rows: mine,
      sharePct: Math.round(share * 1000) / 10,
    });
  }

  breakdown.sort((a, b) => b.bytes - a.bytes);
  return {
    estimatedBytes,
    breakdown,
    tablesOmitted: Math.max(0, scoped.length - sampled.length),
  };
}

/**
 * Business activity over the last 30 days — the closest honest answer to
 * "how much are they using it?", since request traffic is not recorded anywhere.
 */
export async function getTenantActivity(tenantId: string): Promise<TenantActivity> {
  const since = new Date(Date.now() - 30 * 24 * 3600_000);

  const [communications, leads, contacts, activities, auditEvents, sessions] =
    await Promise.all([
      basePrisma.communication.count({ where: { tenantId, occurredAt: { gte: since } } }),
      basePrisma.lead.count({ where: { tenantId, createdAt: { gte: since } } }),
      basePrisma.contact.count({ where: { tenantId, createdAt: { gte: since } } }),
      basePrisma.activity.count({ where: { tenantId, createdAt: { gte: since } } }),
      basePrisma.auditLog.count({ where: { tenantId, createdAt: { gte: since } } }),
      basePrisma.userSession.count({ where: { tenantId, createdAt: { gte: since } } }),
    ]);

  return {
    communications30d: communications,
    leadsCreated30d: leads,
    contactsCreated30d: contacts,
    activities30d: activities,
    auditEvents30d: auditEvents,
    sessions30d: sessions,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
