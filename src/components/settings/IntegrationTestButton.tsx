"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, Loader2, PlugZap, TriangleAlert } from "lucide-react";
import { retestIntegration, type FlowResult } from "@/app/actions/integrationFlow";

/**
 * "Test connection" on a connected integration (settings-screens-improvements.md:
 * "so nobody finds out from a customer that email stopped"). Re-tests what is
 * SAVED — the same check the guided setup runs, against the stored values,
 * nothing retyped, nothing sent to a customer — and says the result in words.
 */
export default function IntegrationTestButton({ integrationId }: { integrationId: string }) {
  const [result, setResult] = useState<FlowResult | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <button
        type="button"
        className="btn-secondary btn-sm"
        disabled={pending}
        onClick={() => startTransition(async () => setResult(await retestIntegration(integrationId)))}
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <PlugZap className="size-3.5" aria-hidden />}
        {pending ? "Testing…" : "Test connection"}
      </button>
      <span role="status" aria-live="polite" className="text-xs">
        {result?.kind === "connected" && (
          <span className="inline-flex items-center gap-1.5 text-emerald-300">
            <CheckCircle2 className="size-3.5" aria-hidden /> Working — {result.detail}
          </span>
        )}
        {result?.kind === "failed" && (
          <span className="inline-flex items-center gap-1.5 text-red-300">
            <TriangleAlert className="size-3.5" aria-hidden /> {result.message}
          </span>
        )}
      </span>
    </div>
  );
}
