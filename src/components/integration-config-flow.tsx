"use client";

import { useState, useTransition } from "react";
import {
  getIntegrationFlow,
  validateFlowStep,
  flowField,
  VERIFY_STEP_ID,
  type FieldErrors,
} from "@/lib/integrationFlow";
import { isBooleanTenantCredentialField } from "@/lib/tenantCredentialFields";
import { verifyAndSaveIntegration, retestIntegration, type FlowResult } from "@/app/actions/integrationFlow";

/**
 * The guided setup wizard.
 *
 * The entered values live HERE, in component state, and are sent to the server
 * exactly once — when the owner asks for the connection test on the final step.
 * Stepping forwards and backwards makes no server request at all, which is what
 * makes "an abandoned flow leaves nothing behind" true by construction rather
 * than by cleanup. Per-step validation uses the very same pure module the server
 * action re-runs on the whole bundle, so the client is a convenience and never
 * the authority.
 *
 * `prefill` carries NON-SECRET values only (hostnames, ports, usernames — see
 * the caller in settings/integration-overrides/page.tsx, which filters on
 * isSecretSettingKey). A stored password or token is never sent to the browser,
 * so a reconnect always requires retyping the secret itself while sparing the
 * owner from re-entering the six fields around it.
 */
export function IntegrationConfigFlow({
  integrationId,
  startAtStep,
  prefill = {},
  onDone,
}: {
  integrationId: string;
  /** Where reauth drops the owner in — the step the failure was blamed on. */
  startAtStep?: string | null;
  prefill?: Record<string, string>;
  onDone?: () => void;
}) {
  const flow = getIntegrationFlow(integrationId);
  const initialIndex = Math.max(
    0,
    flow?.steps.findIndex((s) => s.id === startAtStep) ?? 0,
  );

  const [values, setValues] = useState<Record<string, string>>(() => ({ ...prefill }));
  const [stepIndex, setStepIndex] = useState(initialIndex);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [result, setResult] = useState<FlowResult>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  if (!flow) return null;
  const step = flow.steps[stepIndex];
  const isVerifyStep = step.id === VERIFY_STEP_ID;

  function goToStepId(id: string) {
    const index = flow!.steps.findIndex((s) => s.id === id);
    if (index >= 0) setStepIndex(index);
  }

  function next() {
    const stepErrors = validateFlowStep(integrationId, step.id, values);
    setErrors(stepErrors);
    if (Object.keys(stepErrors).length > 0) return;
    setStepIndex((i) => Math.min(i + 1, flow!.steps.length - 1));
  }

  function back() {
    setErrors({});
    setResult({ kind: "idle" });
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  function runTest() {
    startTransition(async () => {
      const outcome = await verifyAndSaveIntegration(integrationId, values);
      setResult(outcome);
      if (outcome.kind === "invalid") {
        setErrors(outcome.fieldErrors);
        goToStepId(outcome.goToStep);
      } else if (outcome.kind === "connected") {
        // The secrets have served their purpose; drop them from memory rather
        // than leaving them in state behind a "Done" screen.
        setValues({});
        onDone?.();
      }
    });
  }

  function runRetest() {
    startTransition(async () => {
      setResult(await retestIntegration(integrationId));
    });
  }

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap items-center gap-2 text-xs" aria-label="Setup steps">
        {flow.steps.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2">
            <span
              className={
                i === stepIndex
                  ? "badge bg-primary/15 text-primary"
                  : i < stepIndex
                    ? "badge bg-emerald-500/15 text-emerald-300"
                    : "badge bg-muted text-muted-foreground"
              }
              aria-current={i === stepIndex ? "step" : undefined}
            >
              {i + 1}. {s.title}
            </span>
            {i < flow.steps.length - 1 && <span className="text-muted-foreground">→</span>}
          </li>
        ))}
      </ol>

      <div className="rounded-md border border-border bg-background/40 p-4">
        <h4 className="text-sm font-medium text-foreground">{step.title}</h4>
        <p className="mt-1 text-xs text-muted-foreground">{step.blurb}</p>

        {!isVerifyStep && (
          <div className="mt-4 space-y-3">
            {step.fieldKeys.map((key) => {
              const field = flowField(integrationId, key);
              if (!field) return null;
              const boolField = isBooleanTenantCredentialField(key);
              const secret = SECRET_FIELD_KEYS.has(key);
              const error = errors[key];
              return (
                <div key={key}>
                  <label className="label" htmlFor={`flow-${integrationId}-${key}`}>
                    {field.label}
                    {field.required === false && (
                      <span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span>
                    )}
                  </label>
                  {boolField ? (
                    <select
                      id={`flow-${integrationId}-${key}`}
                      className="input"
                      value={values[key] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                    >
                      <option value="">— use the platform default —</option>
                      <option value="true">On (implicit TLS, usually port 465)</option>
                      <option value="false">Off (STARTTLS, usually port 587)</option>
                    </select>
                  ) : (
                    <input
                      id={`flow-${integrationId}-${key}`}
                      className="input"
                      type={secret ? "password" : "text"}
                      autoComplete={secret ? "new-password" : "off"}
                      placeholder={field.placeholder}
                      value={values[key] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? `flow-${integrationId}-${key}-error` : undefined}
                    />
                  )}
                  {error && (
                    <p id={`flow-${integrationId}-${key}-error`} className="mt-1 text-xs text-red-400" aria-live="polite">
                      {error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {isVerifyStep && (
          <div className="mt-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              Nothing has been saved yet. These credentials are only stored if the test below succeeds.
            </p>

            {result.kind === "failed" && (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3" aria-live="polite">
                <p className="text-sm text-red-300">{result.message}</p>
                {result.goToStep !== VERIFY_STEP_ID && (
                  <button type="button" className="btn-secondary btn-sm mt-2" onClick={() => goToStepId(result.goToStep)}>
                    Go back and fix this
                  </button>
                )}
              </div>
            )}

            {result.kind === "connected" && (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3" aria-live="polite">
                <p className="text-sm text-emerald-300">{result.detail}</p>
                {result.facts.length > 0 && (
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {result.facts.map((f) => (
                      <div key={f.label} className="contents">
                        <dt>{f.label}</dt>
                        <dd className="text-foreground">{f.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {result.warnings.map((w) => (
                  <p key={w.code} className="mt-2 text-xs text-amber-300">
                    {w.message}
                  </p>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary" onClick={runTest} disabled={pending}>
                {pending ? "Testing…" : result.kind === "connected" ? "Test and save again" : "Test connection and save"}
              </button>
              <button type="button" className="btn-secondary" onClick={runRetest} disabled={pending}>
                Re-test what&apos;s already saved
              </button>
            </div>
          </div>
        )}

        <div className="mt-4 flex gap-2">
          {stepIndex > 0 && (
            <button type="button" className="btn-secondary btn-sm" onClick={back} disabled={pending}>
              Back
            </button>
          )}
          {!isVerifyStep && (
            <button type="button" className="btn-primary btn-sm" onClick={next}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Which flow fields render as password inputs.
 *
 * Mirrors SECRET_KEYS in src/lib/settings.ts, duplicated here because that
 * module pulls in the Prisma client and cannot be imported into a client
 * component. Kept honest by tests/integrationConfigFlow.test.ts, which asserts
 * every secret key this wizard collects is masked.
 */
const SECRET_FIELD_KEYS: ReadonlySet<string> = new Set(["SMTP_PASS", "WA_ACCESS_TOKEN"]);
