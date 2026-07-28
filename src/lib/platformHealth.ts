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
 *   - ERRORS are PLATFORM-WIDE ONLY. `ErrorLog` has no `tenantId` (it is in
 *     GLOBAL_MODELS), so failures cannot be attributed to a tenant. Showing a
 *     global count under a tenant's name would be a lie, so it is reported
 *     separately.
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
};

export type PlatformErrorHealth = {
  last24h: number;
  last7d: number;
  topScopes: { scope: string; count: number }[];
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
  const [members, leads, contacts, sessions] = await Promise.all([
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
  ]);

  const out = new Map<string, TenantHealth>();
  const ensure = (tenantId: string): TenantHealth => {
    let row = out.get(tenantId);
    if (!row) {
      row = { tenantId, users: 0, leads: 0, contacts: 0, lastActiveAt: null };
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

  return out;
}

async function errorHealth(): Promise<PlatformErrorHealth> {
  const [last24h, last7d, scopes] = await Promise.all([
    basePrisma.errorLog.count({ where: { createdAt: { gte: hoursAgo(24) } } }),
    basePrisma.errorLog.count({ where: { createdAt: { gte: hoursAgo(24 * 7) } } }),
    basePrisma.errorLog.groupBy({
      by: ["scope"],
      _count: { _all: true },
      where: { createdAt: { gte: hoursAgo(24 * 7) } },
      orderBy: { _count: { scope: "desc" } },
      take: 5,
    }),
  ]);

  return {
    last24h,
    last7d,
    topScopes: scopes.map((s) => ({ scope: s.scope, count: s._count._all })),
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
