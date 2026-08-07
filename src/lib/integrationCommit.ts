// The decision at the heart of the guided integration setup: validate, test
// against the real provider, and persist ONLY if that test passed.
//
// This lives in its own module, with every side effect injected, for one
// reason: the invariant "an unverified credential is never stored" has to be
// *provable*. Inside the server action it would sit behind requireTenantOwner()
// and a live Prisma client, testable only by asserting regexes against the
// source text — which proves the code reads a certain way, not that it behaves
// a certain way. Here it is an ordinary async function whose only contact with
// the outside world is a `deps` object, so a unit test can hand it a failing
// probe and assert, directly, that the save function was never called.
//
// Same injectable-dependency shape as resolveTenantCredential in settings.ts.

import { getIntegrationFlow, validateWholeFlow, flowFieldKeys, type FieldErrors } from "./integrationFlow";
import type { ProbeResult, ProbeFailureCode, ProbeWarning } from "./integrationProbe";

export type CommitOutcome =
  /** No flow by that id. Nothing tested, nothing saved. */
  | { kind: "unknown_integration" }
  /** Shape validation failed. No provider call was made, nothing saved. */
  | { kind: "invalid"; fieldErrors: FieldErrors; goToStep: string }
  /** The provider rejected it. Nothing saved. */
  | { kind: "failed"; code: ProbeFailureCode; message: string; blameStep: string }
  /** Verified against the provider and persisted. */
  | { kind: "connected"; detail: string; facts: { label: string; value: string }[]; warnings: ProbeWarning[]; savedKeys: string[] };

export type CommitDeps = {
  /** Runs the live connection test. */
  probe: (integrationId: string, values: Record<string, string>) => Promise<ProbeResult>;
  /** Persists the whole bundle. Called at most once, and only after a pass. */
  saveBundle: (values: Record<string, string>) => Promise<void>;
  /** Marks the integration verified. Only after a pass. */
  recordVerified: () => Promise<void>;
};

/**
 * Validate → test → (only then) save.
 *
 * The ordering here is the whole feature. Note that `saveBundle` appears exactly
 * once, in the last branch, after `probe` has returned `ok: true`; every other
 * path returns before reaching it. A reviewer can confirm the invariant by
 * counting call sites, and tests/integrationConfigFlow.test.ts confirms it by
 * making the probe fail and asserting the save counter stayed at zero.
 */
export async function commitVerifiedCredentials(
  integrationId: string,
  rawValues: Readonly<Record<string, string>>,
  deps: CommitDeps,
): Promise<CommitOutcome> {
  const flow = getIntegrationFlow(integrationId);
  if (!flow) return { kind: "unknown_integration" };

  // Only keys this flow declares. The payload comes from the client, so a stray
  // key must not turn into a credential write for an unrelated integration.
  const values: Record<string, string> = {};
  for (const key of flowFieldKeys(flow)) values[key] = String(rawValues?.[key] ?? "").trim();

  const fieldErrors = validateWholeFlow(integrationId, values);
  if (Object.keys(fieldErrors).length > 0) {
    const firstBadKey = Object.keys(fieldErrors)[0];
    const goToStep = flow.steps.find((s) => s.fieldKeys.includes(firstBadKey))?.id ?? flow.steps[0].id;
    return { kind: "invalid", fieldErrors, goToStep };
  }

  const result = await deps.probe(integrationId, values);

  if (!result.ok) {
    // A CANDIDATE failure is NOT a verdict on what is stored, and there is
    // deliberately no `recordFailure` dependency for it to write through.
    //
    // These values were typed into the wizard and — by the invariant above —
    // never saved. Recording the failure against IntegrationConnection would
    // stamp the health of the tenant's CURRENTLY STORED bundle from a probe of
    // completely different credentials: mistype a password while a working
    // integration is live, and the live one flips to "Reconnect" for a secret it
    // has never seen. The owner already learns what went wrong from the returned
    // outcome (the wizard renders it) and the action audits it.
    //
    // Failure state belongs to two places only: `retestIntegration`, which
    // probes exactly what is stored, and `noteIntegrationSendOutcome`, which
    // reports how a real send with the stored bundle actually went.
    return { kind: "failed", code: result.code, message: result.message, blameStep: result.blameStep };
  }

  await deps.saveBundle(values);
  await deps.recordVerified();
  return {
    kind: "connected",
    detail: result.detail,
    facts: result.facts,
    warnings: result.warnings,
    savedKeys: Object.keys(values).filter((k) => values[k] !== ""),
  };
}
