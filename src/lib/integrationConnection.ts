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

/**
 * Best-effort runtime hook for the SEND paths (src/lib/whatsapp.ts,
 * src/lib/email.ts): report how a real send went so an expired credential
 * surfaces as "Reconnect" in settings instead of silently failing every message.
 *
 * Swallows its own errors on purpose. This is telemetry hanging off a send — if
 * recording the state fails (no tenant in scope, table not migrated yet), the
 * send's own result must be unaffected. It is also fire-and-forget at every call
 * site, so it can never add latency to a customer-facing message.
 */
export async function noteIntegrationSendOutcome(
  tenantId: string | null,
  integrationId: string,
  outcome: { ok: true } | { ok: false; failure: ProbeFailure },
  secrets: readonly (string | null | undefined)[] = [],
): Promise<void> {
  if (!tenantId) return;
  try {
    if (outcome.ok) {
      // Only worth a write when something was previously wrong: a healthy
      // integration would otherwise take a row update on every single message.
      const current = await getIntegrationConnection(tenantId, integrationId);
      if (current && current.status === "connected" && current.lastErrorCode === null) return;
      await recordIntegrationVerified(tenantId, integrationId);
      return;
    }
    await recordIntegrationFailure(tenantId, integrationId, outcome.failure, secrets);
  } catch {
    // Never let connection bookkeeping break a send.
  }
}
