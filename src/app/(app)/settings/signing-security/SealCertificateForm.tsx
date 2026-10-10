"use client";

import { useActionState } from "react";
import { createSealCertificate } from "@/app/actions/signingSecuritySettings";

/**
 * "Create it now" — for a workspace that has no sealing certificate yet. One is
 * made automatically at the first completed document; this only lets the owner
 * see it exists before that first customer signs.
 */
export function SealCertificateForm() {
  const [state, action, working] = useActionState(createSealCertificate, {});
  return (
    <form action={action} className="mt-4 flex flex-wrap items-center gap-3">
      <button type="submit" disabled={working} className="btn-primary">
        {working ? "Creating…" : "Create the certificate now"}
      </button>
      {state?.error && <p role="alert" className="text-sm text-red-400">{state.error}</p>}
      {state?.ok && <p className="text-sm text-emerald-500">{state.ok}</p>}
    </form>
  );
}
