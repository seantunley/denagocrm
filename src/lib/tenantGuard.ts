/**
 * Phase C tenant guard — PURE injection helpers + the global-model allow-list.
 *
 * These functions do not read env or async context; they just transform Prisma
 * `args`. The impure dispatch (should we scope at all? what is the current
 * tenant?) lives in db.ts and is gated on `tenantEnforcing()`, so with
 * enforcement off none of this runs. Kept pure here so the scoping logic is
 * unit-testable in isolation.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Models that are NOT tenant-owned and must never be auto-scoped. `User` is
 * cross-tenant by design (membership model). Anything NOT in this set is treated
 * as tenant-scoped — an opt-OUT list fails safe (a forgotten table gets scoped,
 * not silently left open). `AppSetting` is deliberately absent: per the Phase C
 * decision it becomes tenant-scoped once its additive `tenantId` slice lands.
 */
export const GLOBAL_MODELS: ReadonlySet<string> = new Set([
  "User",
  "Tenant",
  "TenantMember",
  "ErrorLog",
  "OtpChallenge",
  "Passkey",
  "PushSubscription",
  // Platform-console identity. Global BY DESIGN: a cross-tenant administrator that
  // carried a tenantId would be a contradiction, and scoping these would fail
  // closed on a column that deliberately does not exist. See prisma/schema.prisma.
  "PlatformAdmin",
  "PlatformAdminSession",
  // Backup ledger. Backups are platform-wide (one dump of the whole database), so
  // BackupRun has no tenantId at all. Without this entry the guard would treat it
  // as tenant-scoped and fail closed on a column that deliberately does not exist.
  "BackupRun",
]);

export function isTenantScopedModel(model: string): boolean {
  return !GLOBAL_MODELS.has(model);
}

/** Prisma nested-write operation keywords (relation fields inside `data`). */
const RELATION_WRITE_KEYS = new Set([
  "create",
  "createMany",
  "connect",
  "connectOrCreate",
  "update",
  "updateMany",
  "upsert",
  "set",
  "disconnect",
  "delete",
  "deleteMany",
]);

/**
 * True if `data` (a create/update payload, or an array of them) contains a NESTED
 * RELATION WRITE — a relation field whose value nests create/connect/update/etc.
 *
 * Prisma query extensions only intercept TOP-LEVEL operations, so nested writes
 * are neither tenant-stamped nor validated by this guard; under enforcement they
 * are REFUSED until tenant-aware composite FKs make parent/child consistency
 * safe (see PHASE-C-TENANT-GUARD-DESIGN.md §1.3/§5).
 *
 * Heuristic that avoids false positives on scalars / JSON blobs: a plain-object
 * field value is a relation write only if EVERY key is a relation-op keyword (a
 * JSON column like `{ create: 1, other: 2 }` has a non-keyword key, so it's not
 * flagged; a scalar, Date, or array is never flagged).
 */
export function hasNestedRelationWrite(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const value of Object.values(row as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
        continue;
      }
      const keys = Object.keys(value as Record<string, unknown>);
      if (keys.length > 0 && keys.every((k) => RELATION_WRITE_KEYS.has(k))) {
        return true;
      }
    }
  }
  return false;
}

/** Thrown when enforcement is on but no usable tenant scope is present. */
export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}

/**
 * Reads + single-row mutation targeting: force `where.tenantId = tenantId`.
 * For find* collections the where is a plain filter; for update/delete the extra
 * field is allowed alongside the unique key via extendedWhereUnique (Prisma 5+,
 * the same mechanism the soft-delete guard relies on for `deletedAt`).
 */
export function scopeWhere(args: any, tenantId: string): any {
  const next = { ...(args ?? {}) };
  next.where = { ...(next.where ?? {}), tenantId };
  return next;
}

/**
 * create / createMany: force the owning tenant onto the row(s), overwriting any
 * client-supplied `tenantId`. This is the core anti-forgery rule — a write's
 * tenant comes from trusted context, never the payload.
 */
export function stampCreate(args: any, tenantId: string): any {
  const next = { ...(args ?? {}) };
  if (Array.isArray(next.data)) {
    next.data = next.data.map((d: any) => ({ ...d, tenantId }));
  } else {
    next.data = { ...(next.data ?? {}), tenantId };
  }
  return next;
}

/**
 * update / updateMany / delete / deleteMany: scope the `where` to the tenant AND
 * prevent a data payload from moving the row to another tenant (force `tenantId`
 * back to context if the caller tried to set it).
 */
export function scopeMutation(args: any, tenantId: string): any {
  const next = scopeWhere(args, tenantId);
  const data = next.data;
  if (data && typeof data === "object" && !Array.isArray(data) && "tenantId" in data) {
    next.data = { ...data, tenantId };
  }
  return next;
}

/**
 * upsert: scope the `where`, stamp the create branch, and guard the update branch.
 *
 * Prisma 6 `WhereUniqueInput` accepts additional non-unique fields alongside the
 * unique selector (extendedWhereUnique, GA), so we DO inject `tenantId` into the
 * where. Effect for a cross-tenant upsert: the unique lookup is scoped to the
 * caller's tenant → it misses another tenant's row → Prisma takes the CREATE
 * branch (stamped with the caller's tenant) instead of silently updating the
 * other tenant's row. Before business uniqueness is tenant-scoped (step 6) that
 * create may then hit the still-global unique constraint and error — a safe,
 * fail-closed outcome, never a cross-tenant write. RLS remains the authoritative
 * backstop.
 */
export function scopeUpsert(args: any, tenantId: string): any {
  const next = { ...(args ?? {}) };
  next.where = { ...(next.where ?? {}), tenantId };
  next.create = { ...(next.create ?? {}), tenantId };
  const update = next.update;
  if (update && typeof update === "object" && "tenantId" in update) {
    next.update = { ...update, tenantId };
  }
  return next;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
