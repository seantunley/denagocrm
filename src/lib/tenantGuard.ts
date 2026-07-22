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
]);

export function isTenantScopedModel(model: string): boolean {
  return !GLOBAL_MODELS.has(model);
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
 * upsert: stamp the create branch and guard the update branch. The `where` is
 * left untouched — upsert's where must be a unique selector and cannot carry an
 * extra `tenantId` filter, so cross-tenant reach via a globally-unique key on an
 * upsert is backstopped by RLS (WITH CHECK), not the app layer. Documented
 * limitation, revisited when enforcement lands.
 */
export function scopeUpsert(args: any, tenantId: string): any {
  const next = { ...(args ?? {}) };
  next.create = { ...(next.create ?? {}), tenantId };
  const update = next.update;
  if (update && typeof update === "object" && "tenantId" in update) {
    next.update = { ...update, tenantId };
  }
  return next;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
