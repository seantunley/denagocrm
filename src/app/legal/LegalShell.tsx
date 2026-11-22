import Link from "next/link";
import type { ReactNode } from "react";
import { PLATFORM, companyComplete } from "@/lib/platformLegal";

/**
 * The public legal pages (privacy, terms, data deletion) — the platform's own, in Honeycomb 360's name on every
 * domain, because they describe the operator, not a workspace. Plain and readable; no session, nothing loaded.
 */
export function LegalShell({ title, children }: { title: string; children: ReactNode }) {
  const complete = companyComplete();
  return (
    <div className="min-h-screen bg-white text-slate-800">
      <div className="w-full px-4 py-10 sm:px-8">
        <p className="text-sm font-semibold tracking-wide text-amber-600">{PLATFORM.name}</p>
        <h1 className="mt-1 text-3xl font-bold text-slate-900">{title}</h1>
        <p className="mt-1 text-sm text-slate-500">Effective {PLATFORM.effectiveDate}</p>
        <nav className="mt-4 flex flex-wrap gap-4 text-sm">
          <Link className="text-amber-700 underline" href="/legal/privacy">Privacy policy</Link>
          <Link className="text-amber-700 underline" href="/legal/terms">Terms of service</Link>
          <Link className="text-amber-700 underline" href="/legal/data-deletion">Data deletion</Link>
        </nav>
        {!complete && (
          <p className="mt-6 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            Draft: the operating company&apos;s registered details are still being added to this page.
          </p>
        )}
        <div className="legal-body mt-8 space-y-4 leading-relaxed [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-slate-900 [&_li]:ml-5 [&_li]:list-disc">
          {children}
        </div>
        <footer className="mt-12 border-t border-slate-200 pt-6 text-sm text-slate-500">
          <Operator />
        </footer>
      </div>
    </div>
  );
}

/** Who runs Honeycomb 360, and where to write. */
export function Operator() {
  if (!companyComplete()) return <p>{PLATFORM.name} — {PLATFORM.domain}</p>;
  return (
    <p>
      {PLATFORM.name} is operated by {PLATFORM.companyName} (registration number {PLATFORM.registrationNumber}),{" "}
      {PLATFORM.address}. Privacy and data requests: <a className="underline" href={`mailto:${PLATFORM.privacyEmail}`}>{PLATFORM.privacyEmail}</a>.
    </p>
  );
}

/** "Write to us" — the privacy address when it is known. */
export function PrivacyContact() {
  return PLATFORM.privacyEmail
    ? <a className="underline" href={`mailto:${PLATFORM.privacyEmail}`}>{PLATFORM.privacyEmail}</a>
    : <span>the privacy contact shown at the foot of this page</span>;
}
