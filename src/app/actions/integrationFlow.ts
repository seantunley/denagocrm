"use server";

import { revalidatePath } from "next/cache";
import { requireTenantOwner, getActiveTenantId } from "@/lib/auth";
import { putTenantCredentialBundle } from "@/lib/settings";
import { logAuditStrict } from "@/lib/audit";
import { getIntegrationFlow, flowFieldKeys, VERIFY_STEP_ID, type FieldErrors } from "@/lib/integrationFlow";
import { probeIntegration, type ProbeWarning } from "@/lib/integrationProbe";
import { recordIntegrationVerified, recordIntegrationFailure } from "@/lib/integrationConnection";
import { commitVerifiedCredentials } from "@/lib/integrationCommit";

const OVERRIDES_PATH = "/settings/integration-overrides";

/**
 * What the wizard renders. Structured rather than `ActionResult` because the
 * step UI needs to know WHICH field was wrong and WHICH step to jump to.
 *
 * Note what is absent: the submitted values. Nothing the owner typed is echoed
 * back in this payload — a server action's return is serialised to the browser,
 * and bouncing a password back through it would put the secret in the RSC
 * stream on every failed attempt.
 */
export type FlowResult =
  | { kind: "idle" }
  /** Shape validation failed; no connection test was attempted, nothing saved. */
  | { kind: "invalid"; fieldErrors: FieldErrors; goToStep: string }
  /** The live test failed. Nothing was saved. */
  | { kind: "failed"; code: string; message: string; goToStep: string }
  /** The live test passed and the credentials are now stored. */
  | { kind: "connected"; detail: string; facts: { label: string; value: string }[]; warnings: ProbeWarning[] };

/**
 * Run a live connection test and, ONLY if it passes, store the credentials.
 *
 * ── The central invariant ──────────────────────────────────────────────────
 * An unverified credential is never written. There is exactly one call to
 * `putTenantCredentialBundle` in this function and every early return above it
 * exits before reaching it, so "the test is decoration" is a structural
 * impossibility rather than a policy someone has to remember. Guarded by
 * tests/integrationConfigFlow.test.ts.
 *
 * ── What happens to a half-finished flow ───────────────────────────────────
 * Nothing, because a half-finished flow has no server-side existence. The
 * wizard validates each step in the browser from the same pure module this
 * action uses (src/lib/integrationFlow.ts) and holds the entered values in
 * component state; the first and only request to the server is this one, with
 * the complete bundle. An abandoned flow is therefore discarded when the tab
 * closes — there is no draft table to garbage-collect and, critically, no
 * intermediate store of half-verified secrets. The alternative (persisting a
 * draft as the user goes) would have re-created exactly the thing this feature
 * exists to prevent: stored credentials nobody has proven.
 *
 * ── Secrets ────────────────────────────────────────────────────────────────
 * `values` is the only place a secret appears. It is never logged, never put in
 * the audit entry (which records key NAMES and the probe verdict only), and
 * never returned to the browser. Probe failures come back as sentences written
 * in integrationProbe.ts, not provider bodies.
 */
export async function verifyAndSaveIntegration(
  integrationId: string,
  values: Record<string, string>,
): Promise<FlowResult> {
  // A server action is a POST endpoint reachable directly, so the page's own
  // guard is not enough — re-check, exactly as tenantCredentials.ts does.
  const user = await requireTenantOwner();

  const flow = getIntegrationFlow(integrationId);
  if (!flow) {
    return { kind: "failed", code: "invalid_input", message: "That integration has no guided setup.", goToStep: VERIFY_STEP_ID };
  }

  const tenantId = await getActiveTenantId();
  if (!tenantId) {
    return {
      kind: "failed",
      code: "invalid_input",
      message: "No active tenant is resolved for your account, so there is nothing to connect.",
      goToStep: VERIFY_STEP_ID,
    };
  }

  // The validate → test → save decision itself lives in commitVerifiedCredentials
  // (src/lib/integrationCommit.ts) with its side effects injected, so the
  // "never persist an unverified credential" invariant can be unit-tested
  // directly rather than asserted against this file's source text. Everything
  // this action adds around it is auth, wiring, auditing and revalidation.
  const secrets = Object.values(values ?? {});
  const outcome = await commitVerifiedCredentials(integrationId, values ?? {}, {
    probe: (id, clean) => probeIntegration(id, clean),
    saveBundle: (clean) => putTenantCredentialBundle(tenantId, clean),
    recordVerified: () => recordIntegrationVerified(tenantId, integrationId),
    recordFailure: (failure) => recordIntegrationFailure(tenantId, integrationId, failure, secrets),
  });

  if (outcome.kind === "unknown_integration") {
    return { kind: "failed", code: "invalid_input", message: "That integration has no guided setup.", goToStep: VERIFY_STEP_ID };
  }

  if (outcome.kind === "invalid") {
    // No provider call was made and nothing was written.
    return { kind: "invalid", fieldErrors: outcome.fieldErrors, goToStep: outcome.goToStep };
  }

  if (outcome.kind === "failed") {
    await logAuditStrict({
      action: "integration.connection_test_failed",
      summary: `Connection test for ${flow.label} failed (${outcome.code})`,
      entityType: "IntegrationConnection",
      entityId: `${tenantId}:${integrationId}`,
      user,
      // Codes and step names only — never what was typed.
      after: { integrationId, code: outcome.code, blameStep: outcome.blameStep },
    });
    revalidatePath(OVERRIDES_PATH);
    return { kind: "failed", code: outcome.code, message: outcome.message, goToStep: outcome.blameStep };
  }

  await logAuditStrict({
    action: "integration.connected",
    summary: `Verified and connected ${flow.label}`,
    entityType: "IntegrationConnection",
    entityId: `${tenantId}:${integrationId}`,
    user,
    // The KEYS that were set, never what they were set to — same rule as
    // tenant_credential.override_set in tenantCredentials.ts.
    after: { integrationId, keys: outcome.savedKeys },
  });

  revalidatePath(OVERRIDES_PATH);
  return { kind: "connected", detail: outcome.detail, facts: outcome.facts, warnings: outcome.warnings };
}

/**
 * Re-test the credentials ALREADY stored for an integration, without asking the
 * owner to re-enter anything.
 *
 * This is the cheap half of reauth: a token that was flagged after a failed send
 * may have simply been rate-limited, and an owner who fixed the problem at the
 * provider's end (re-granting a permission, say) should be able to clear the
 * flag without retyping a working password. Reads the stored bundle through the
 * ordinary resolver, so it tests exactly what the send paths would use.
 */
export async function retestIntegration(integrationId: string): Promise<FlowResult> {
  const user = await requireTenantOwner();

  const flow = getIntegrationFlow(integrationId);
  if (!flow) {
    return { kind: "failed", code: "invalid_input", message: "That integration has no guided setup.", goToStep: VERIFY_STEP_ID };
  }

  const tenantId = await getActiveTenantId();
  if (!tenantId) {
    return { kind: "failed", code: "invalid_input", message: "No active tenant is resolved for your account.", goToStep: VERIFY_STEP_ID };
  }

  const { resolveIntegrationBundle } = await import("@/lib/settings");
  const bundle = await resolveIntegrationBundle(tenantId, integrationId);
  if (!bundle) {
    return {
      kind: "failed",
      code: "invalid_input",
      message: "There are no credentials stored for this integration yet — run the setup first.",
      goToStep: flow.steps[0].id,
    };
  }

  const clean: Record<string, string> = {};
  for (const key of flowFieldKeys(flow)) clean[key] = String(bundle[key] ?? "").trim();

  const result = await probeIntegration(integrationId, clean);

  if (!result.ok) {
    await recordIntegrationFailure(
      tenantId,
      integrationId,
      { code: result.code, message: result.message, blameStep: result.blameStep },
      Object.values(clean),
    );
    revalidatePath(OVERRIDES_PATH);
    return { kind: "failed", code: result.code, message: result.message, goToStep: result.blameStep };
  }

  await recordIntegrationVerified(tenantId, integrationId);
  await logAuditStrict({
    action: "integration.reverified",
    summary: `Re-tested ${flow.label} and it is working again`,
    entityType: "IntegrationConnection",
    entityId: `${tenantId}:${integrationId}`,
    user,
    after: { integrationId },
  });
  revalidatePath(OVERRIDES_PATH);
  return { kind: "connected", detail: result.detail, facts: result.facts, warnings: result.warnings };
}
