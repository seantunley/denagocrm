import "server-only";

import { basePrisma } from "@/lib/db";

/**
 * Health data for the platform console.
 *
 * Deliberately honest about what the schema can and cannot answer today:
 *
 *   - BACKUPS are PLATFORM-WIDE. `exportAllData` dumps the whole database; there
 *     is no per-tenant backup, so every tenant shares one status. Reported as a
 *     platform fact rather than repeated per tenant as if it were per-tenant.
 *   - SIZE / ACTIVITY is genuinely per-tenant: Lead and Contact carry `tenantId`,
 *     membership gives the user count, and UserSession carries both `tenantId` and
 *     `lastActiveAt`.
 *   - ERRORS are per-tenant WHERE THEY CAN BE. `logError` stamps the acting
 *     tenant, so attributed errors are reported on that tenant. Some genuinely
 *     have no tenant — pre-auth failures, webhooks, cron, and rows predating the
 *     column — and those are reported separately as "unattributed" rather than
 *     being folded into a tenant that did not cause them.
 *   - INTEGRATION health is NOT AVAILABLE. Per-tenant integration credentials live
 *     in the credential-isolation work that has not landed; there is nothing to
 *     read. Omitted rather than faked.
 *
 * All reads use `basePrisma`: this is cross-tenant platform work by definition.
 */

/** A backup is considered overdue after this long without a successful run. */
export const BACKUP_STALE_HOURS = 36;
/** A run still "running" after this long almost certainly died. */
export const BACKUP_STUCK_HOURS = 6;

export type BackupHealth = {
  status: "never" | "ok" | "degraded" | "failed" | "stuck" | "overdue";
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  durationMs: number | null;
  sizeBytes: number | null;
  error: string | null;
  /** Consecutive failures since the last success — a single blip vs a real outage. */
  recentFailures: number;
};

export type TenantHealth = {
  tenantId: string;
  users: number;
  leads: number;
  contacts: number;
  /** Most recent staff session activity for this tenant, or null if never. */
  lastActiveAt: Date | null;
  /** Errors attributed to this tenant. */
  errors24h: number;
  errors7d: number;
};

/**
 * Errors that could NOT be attributed to a tenant — pre-auth failures, webhooks,
 * cron sweeps, and rows predating the tenantId column. Reported separately rather
 * than folded into a tenant, which would be a lie.
 */
export type PlatformErrorHealth = {
  unattributed24h: number;
  unattributed7d: number;
  topScopes: { scope: string; count: number }[];
  /** Errors across ALL tenants in the last 24h — the "is anything wrong" number. */
  total24h: number;
  /**
   * The most recent errors themselves, newest first. A COUNT alone cannot tell you
   * whether to act; you need to see what actually broke. `tenantId` is null for
   * unattributed ones.
   */
  recent: {
    id: string;
    tenantId: string | null;
    scope: string;
    message: string;
    createdAt: Date;
  }[];
};

export type PlatformHealth = {
  backup: BackupHealth;
  tenants: Map<string, TenantHealth>;
  errors: PlatformErrorHealth;
};

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3600_000);
}

async function backupHealth(): Promise<BackupHealth> {
  const runs = await basePrisma.backupRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 20,
    select: {
      status: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
      sizeBytes: true,
      error: true,
      degraded: true,
    },
  });

  if (runs.length === 0) {
    // No ledger rows at all. Note this is also the state immediately after the
    // ledger ships but before the next nightly run — "never" here means "not
    // recorded", which is exactly what we can honestly say.
    return {
      status: "never",
      lastRunAt: null,
      lastSuccessAt: null,
      durationMs: null,
      sizeBytes: null,
      error: null,
      recentFailures: 0,
    };
  }

  const latest = runs[0];
  const lastSuccess = runs.find((r) => r.status === "success") ?? null;

  // Failures since the last success, so one bad night reads differently from four.
  let recentFailures = 0;
  for (const run of runs) {
    if (run.status === "success") break;
    if (run.status === "failed") recentFailures += 1;
  }

  const status: BackupHealth["status"] = (() => {
    // A run still "running" well past its start died without closing its row.
    // Silence would otherwise be indistinguishable from a healthy quiet period.
    if (latest.status === "running" && latest.startedAt < hoursAgo(BACKUP_STUCK_HOURS)) {
      return "stuck";
    }
    if (latest.status === "failed") return "failed";
    if (!lastSuccess) return "failed";
    if (lastSuccess.startedAt < hoursAgo(BACKUP_STALE_HOURS)) return "overdue";
    if (latest.status === "success" && latest.degraded) return "degraded";
    return "ok";
  })();

  return {
    status,
    lastRunAt: latest.startedAt,
    lastSuccessAt: lastSuccess?.startedAt ?? null,
    durationMs: lastSuccess?.durationMs ?? latest.durationMs,
    sizeBytes: lastSuccess?.sizeBytes ?? null,
    error: latest.status === "failed" ? latest.error : null,
    recentFailures,
  };
}

async function tenantHealth(): Promise<Map<string, TenantHealth>> {
  // One grouped query per signal rather than N queries per tenant, so the console
  // stays O(1) in database round-trips as tenants are added.
  const [members, leads, contacts, sessions, errors24h, errors7d] = await Promise.all([
    basePrisma.tenantMember.groupBy({ by: ["tenantId"], _count: { _all: true } }),
    basePrisma.lead.groupBy({
      by: ["tenantId"],
      _count: { _all: true },
      where: { deletedAt: null },
    }),
    basePrisma.contact.groupBy({
      by: ["tenantId"],
      _count: { _all: true },
      where: { deletedAt: null },
    }),
    basePrisma.userSession.groupBy({
      by: ["tenantId"],
      _max: { lastActiveAt: true },
    }),
    basePrisma.errorLog.groupBy({
      by: ["tenantId"],
      _count: { _all: true },
      where: { createdAt: { gte: hoursAgo(24) }, tenantId: { not: null } },
    }),
    basePrisma.errorLog.groupBy({
      by: ["tenantId"],
      _count: { _all: true },
      where: { createdAt: { gte: hoursAgo(24 * 7) }, tenantId: { not: null } },
    }),
  ]);

  const out = new Map<string, TenantHealth>();
  const ensure = (tenantId: string): TenantHealth => {
    let row = out.get(tenantId);
    if (!row) {
      row = {
        tenantId,
        users: 0,
        leads: 0,
        contacts: 0,
        lastActiveAt: null,
        errors24h: 0,
        errors7d: 0,
      };
      out.set(tenantId, row);
    }
    return row;
  };

  for (const m of members) ensure(m.tenantId).users = m._count._all;
  for (const l of leads) if (l.tenantId) ensure(l.tenantId).leads = l._count._all;
  for (const c of contacts) if (c.tenantId) ensure(c.tenantId).contacts = c._count._all;
  for (const s of sessions) {
    if (s.tenantId) ensure(s.tenantId).lastActiveAt = s._max.lastActiveAt ?? null;
  }
  for (const e of errors24h) if (e.tenantId) ensure(e.tenantId).errors24h = e._count._all;
  for (const e of errors7d) if (e.tenantId) ensure(e.tenantId).errors7d = e._count._all;

  return out;
}

async function errorHealth(): Promise<PlatformErrorHealth> {
  // Only the UNATTRIBUTED ones: anything with a tenant is reported on that tenant's
  // row instead. Counting everything here would double-count and reproduce the
  // original problem — a single number nobody can act on.
  const [unattributed24h, unattributed7d, scopes, total24h, recent] = await Promise.all([
    basePrisma.errorLog.count({
      where: { createdAt: { gte: hoursAgo(24) }, tenantId: null },
    }),
    basePrisma.errorLog.count({
      where: { createdAt: { gte: hoursAgo(24 * 7) }, tenantId: null },
    }),
    basePrisma.errorLog.groupBy({
      by: ["scope"],
      _count: { _all: true },
      where: { createdAt: { gte: hoursAgo(24 * 7) }, tenantId: null },
      orderBy: { _count: { scope: "desc" } },
      take: 5,
    }),
    // Across every tenant AND unattributed — the single "is anything wrong now?"
    // number that decides whether the console shouts or stays quiet.
    basePrisma.errorLog.count({ where: { createdAt: { gte: hoursAgo(24) } } }),
    // The errors themselves. A count cannot guide anyone; seeing "smtp: connection
    // refused" can. Capped so a storm cannot flood the page.
    basePrisma.errorLog.findMany({
      where: { createdAt: { gte: hoursAgo(24 * 7) } },
      orderBy: { createdAt: "desc" },
      take: 15,
      select: { id: true, tenantId: true, scope: true, message: true, createdAt: true },
    }),
  ]);

  return {
    unattributed24h,
    unattributed7d,
    topScopes: scopes.map((s) => ({ scope: s.scope, count: s._count._all })),
    total24h,
    recent,
  };
}

/** Everything the console health view needs, in as few round-trips as practical. */
export async function getPlatformHealth(): Promise<PlatformHealth> {
  const [backup, tenants, errors] = await Promise.all([
    backupHealth(),
    tenantHealth(),
    errorHealth(),
  ]);
  return { backup, tenants, errors };
}
