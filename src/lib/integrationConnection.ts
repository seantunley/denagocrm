// Persistence for "did this tenant's integration credentials actually work last
// time we used them" — the state behind the Connected / Reconnect badges and the
// reauth routing.
//
// TENANT SAFETY. Every function here takes an EXPLICIT tenantId and pins it in
// the query, and every write targets the (tenantId, integrationId) compound
// unique key. That is deliberate and matches src/lib/settings.ts: these
// functions are called from cron sweeps and webhook handlers that may have no
// request-scoped tenant in ambient scope at all, so reading the tenant from
// scope would fail (or, worse, silently resolve to the wrong tenant). `prisma`
// here is the SCOPED client — the tenant extension still applies — and the
// explicit tenantId means the query is correct with or without it. No $queryRaw,
// no $executeRaw, no basePrisma: nothing in this module bypasses the extension.
//
// SECRETS. This table never holds credential material. `lastErrorText` is only
// ever written from the curated, redacted sentences produced by
// integrationProbe.ts, and `recordIntegrationFailure` redacts again on the way
// in — a caller cannot store a raw provider body here even by mistake.

import { prisma } from "./db";
import { runAfterResponse } from "./afterResponse";
import { failureRequiresReauth, redactSecrets, type ProbeFailure, type ProbeFailureCode } from "./integrationProbe";

export type IntegrationConnectionState = {
  integrationId: string;
  status: "connected" | "reauth_required";
  lastVerifiedAt: Date | null;
  blameStep: string | null;
  lastErrorCode: string | null;
  lastErrorText: string | null;
  lastErrorAt: Date | null;
};

/**
 * Verification state for one integration, or null when it has never been
 * verified through the guided flow. Null is a real state the UI renders
 * ("Not verified"), distinct from "verified and broken".
 */
export async function getIntegrationConnection(
  tenantId: string,
  integrationId: string,
): Promise<IntegrationConnectionState | null> {
  const row = await prisma.integrationConnection.findUnique({
    where: { tenantId_integrationId: { tenantId, integrationId } },
  });
  return row ? toState(row) : null;
}

/** Verification state for all of a tenant's integrations, keyed by integration id. */
export async function getIntegrationConnections(
  tenantId: string,
): Promise<Map<string, IntegrationConnectionState>> {
  const rows = await prisma.integrationConnection.findMany({ where: { tenantId } });
  return new Map(rows.map((row) => [row.integrationId, toState(row)]));
}

function toState(row: {
  integrationId: string;
  status: string;
  lastVerifiedAt: Date | null;
  blameStep: string | null;
  lastErrorCode: string | null;
  lastErrorText: string | null;
  lastErrorAt: Date | null;
}): IntegrationConnectionState {
  return {
    integrationId: row.integrationId,
    status: row.status === "reauth_required" ? "reauth_required" : "connected",
    lastVerifiedAt: row.lastVerifiedAt,
    blameStep: row.blameStep,
    lastErrorCode: row.lastErrorCode,
    lastErrorText: row.lastErrorText,
    lastErrorAt: row.lastErrorAt,
  };
}

/**
 * Records that a live probe (or a real send) just succeeded.
 *
 * Clears the failure fields, so an integration that was in reauth and has since
 * been fixed — or that failed on a blip and then worked — heals itself without
 * anyone clicking anything.
 */
export async function recordIntegrationVerified(tenantId: string, integrationId: string): Promise<void> {
  const now = new Date();
  await prisma.integrationConnection.upsert({
    where: { tenantId_integrationId: { tenantId, integrationId } },
    update: {
      status: "connected",
      lastVerifiedAt: now,
      blameStep: null,
      lastErrorCode: null,
      lastErrorText: null,
      lastErrorAt: null,
    },
    create: { tenantId, integrationId, status: "connected", lastVerifiedAt: now },
  });
}

/**
 * Records a failure, flipping the integration into "reauth required" only when
 * the provider blamed the CREDENTIAL (see REAUTH_FAILURE_CODES).
 *
 * A transient failure still updates `lastErrorText` — so the owner can see what
 * happened — but leaves `status` alone, because there is nothing for them to
 * re-enter. `lastVerifiedAt` is never cleared: "connected until 3 March" is far
 * more useful than "broken".
 */
export async function recordIntegrationFailure(
  tenantId: string,
  integrationId: string,
  failure: { code: ProbeFailureCode; message: string; blameStep: string },
  /** Values to scrub from `message` — belt and braces; probes redact already. */
  secrets: readonly (string | null | undefined)[] = [],
): Promise<void> {
  const needsReauth = failureRequiresReauth(failure.code);
  const text = redactSecrets(failure.message, secrets).slice(0, 1000);
  const now = new Date();

  const failureFields = {
    lastErrorCode: failure.code,
    lastErrorText: text,
    lastErrorAt: now,
    ...(needsReauth ? { status: "reauth_required" as const, blameStep: failure.blameStep } : {}),
  };

  await prisma.integrationConnection.upsert({
    where: { tenantId_integrationId: { tenantId, integrationId } },
    update: failureFields,
    create: {
      tenantId,
      integrationId,
      status: needsReauth ? "reauth_required" : "connected",
      blameStep: needsReauth ? failure.blameStep : null,
      lastErrorCode: failure.code,
      lastErrorText: text,
      lastErrorAt: now,
    },
  });
}

/** Injection seam for unit tests only; all real callers use the defaults. */
export type SendOutcomeDeps = {
  read?: (tenantId: string, integrationId: string) => Promise<IntegrationConnectionState | null>;
  recordVerified?: (tenantId: string, integrationId: string) => Promise<void>;
  recordFailure?: (
    tenantId: string,
    integrationId: string,
    failure: { code: ProbeFailureCode; message: string; blameStep: string },
    secrets: readonly (string | null | undefined)[],
  ) => Promise<void>;
  schedule?: (work: () => Promise<void>) => Promise<void>;
};

/**
 * Runtime hook for the SEND paths (src/lib/whatsapp.ts, src/lib/email.ts):
 * report how a real send went so an expired credential surfaces as "Reconnect"
 * in settings instead of silently failing every message.
 *
 * `tenantId` is a REQUIRED, non-nullable string, and it must be the tenant the
 * credentials that performed the send were resolved FOR — see
 * `credentialOwnerTenantId` in src/lib/settings.ts, which the send paths call
 * beside their credential lookup and thread through here. This function does not
 * (and must not) consult `currentTenantScope()`:
 *
 *   - Request tenant scope is a deliberate NO-OP while enforcement is off, and
 *     enforcement is off in production. Re-reading it would yield null on a
 *     normal user-triggered send, and a null-tolerant signature would then drop
 *     the report — the health badge would move for cron probes and never for the
 *     sends that actually matter.
 *   - Cron sweeps and webhook handlers legitimately run with no scope at all.
 *
 * Making the parameter non-nullable is the enforcement: there is no longer a
 * value a caller can pass that means "work it out yourself".
 *
 * LIFECYCLE. The write is handed to {@link runAfterResponse}, which registers it
 * with the platform's post-response mechanism (`after()`/`waitUntil`) inside a
 * request and awaits it everywhere else. It is never started and abandoned: an
 * unawaited async call can be — and on serverless routinely is — killed the
 * instant the response flushes, losing the write silently. Awaiting this call is
 * cheap: in a request it returns as soon as the work is registered.
 *
 * Errors are still swallowed whole (runAfterResponse guarantees it). This is
 * telemetry hanging off a customer-facing send; if the table is not migrated yet
 * or the row write fails, the send's own result must be unaffected.
 */
export async function noteIntegrationSendOutcome(
  tenantId: string,
  integrationId: string,
  outcome: { ok: true } | { ok: false; failure: ProbeFailure },
  secrets: readonly (string | null | undefined)[] = [],
  deps: SendOutcomeDeps = {},
): Promise<void> {
  const schedule = deps.schedule ?? runAfterResponse;
  const read = deps.read ?? getIntegrationConnection;
  const recordVerified = deps.recordVerified ?? recordIntegrationVerified;
  const recordFailure = deps.recordFailure ?? recordIntegrationFailure;

  await schedule(async () => {
    if (outcome.ok) {
      // Only worth a write when something was previously wrong: a healthy
      // integration would otherwise take a row update on every single message.
      const current = await read(tenantId, integrationId);
      if (current && current.status === "connected" && current.lastErrorCode === null) return;
      await recordVerified(tenantId, integrationId);
      return;
    }
    await recordFailure(tenantId, integrationId, outcome.failure, secrets);
  });
}

/**
 * Drops the verification verdict for one integration, because the credentials
 * underneath it just changed.
 *
 * The per-key save/clear controls on the overrides page write
 * `TenantIntegrationCredential` directly, never through the wizard, so nothing
 * about the stored bundle is proven afterwards — but the row here would happily
 * keep reporting "Connected, verified on the 3rd" about a password that has
 * since been replaced or deleted. The UI ranks `lastVerifiedAt` above override
 * presence, so the stale verdict wins on screen: the worst possible answer,
 * confidently given.
 *
 * DELETES rather than flags. "Never verified" is already a state this table
 * models (a missing row) and it is exactly the true one — the new credentials
 * have not been tested. Writing `reauth_required` instead would claim the
 * provider rejected something, which nobody has asked it.
 *
 * Deletes by (tenantId, integrationId) with deleteMany, so invalidating an
 * integration that was never verified is a no-op rather than a P2025.
 */
export async function clearIntegrationVerification(
  tenantId: string,
  integrationId: string,
): Promise<void> {
  await prisma.integrationConnection.deleteMany({ where: { tenantId, integrationId } });
}
