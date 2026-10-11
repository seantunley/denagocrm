"use client";

import { useState, useTransition } from "react";
import { ShieldCheck } from "lucide-react";
import { checkSendingDomain, type SendingDomainReport } from "@/app/actions/sendingDomain";
import { StatusPill } from "@/components/visual-system";
import type { DomainCheckState } from "@/lib/sendingDomain";

const TONE: Record<DomainCheckState, { tone: "success" | "warning" | "danger" | "neutral"; label: string }> = {
  good: { tone: "success", label: "In place" },
  warn: { tone: "warning", label: "Could be stronger" },
  bad: { tone: "danger", label: "Needs fixing" },
  unknown: { tone: "neutral", label: "Can't tell from here" },
};

/**
 * Settings → Email → Outgoing email: "is my email set up to be trusted?".
 * Runs only when asked — it looks the domain up in public DNS, which takes a
 * moment and is pointless on every visit to the page.
 */
export default function SendingDomainCheck() {
  const [report, setReport] = useState<SendingDomainReport | null>(null);
  const [checking, startCheck] = useTransition();
  const run = () =>
    startCheck(async () => {
      setReport(await checkSendingDomain().catch(() => ({ ok: false as const, error: "The check could not run. Try again." })));
    });

  return (
    <div className="mt-4 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 basis-80">
          <p className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4 text-primary" aria-hidden />Is your email set up to be trusted?</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Checks the three public records (SPF, DKIM, DMARC) that decide whether Gmail and Outlook deliver your email or send
            it to spam. It only reads; nothing is changed and no email is sent.
          </p>
        </div>
        <button type="button" className="btn-secondary btn-sm shrink-0" onClick={run} disabled={checking}>{checking ? "Checking…" : report ? "Check again" : "Check now"}</button>
      </div>

      {report && !report.ok && <p className="mt-3 text-sm text-amber-300">{report.error}</p>}
      {report?.ok && (
        <div className="mt-3 space-y-3">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <StatusPill tone={TONE[report.verdict.state].tone}>{report.domain}</StatusPill>
            <span className="text-foreground">{report.verdict.text}</span>
          </p>
          <ul className="space-y-2">
            {report.checks.map((check) => (
              <li key={check.key} className="rounded-md bg-muted/40 p-3">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{check.label}<StatusPill tone={TONE[check.state].tone}>{TONE[check.state].label}</StatusPill></p>
                <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{check.found}</p>
                <p className="mt-1 text-xs text-foreground/80">{check.meaning}</p>
                {check.fix && <p className="mt-1 text-xs text-foreground"><span className="font-semibold">What to do:</span> {check.fix}</p>}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">These records are changed where your domain&apos;s DNS is managed, not in the CRM. Changes can take up to a day to show here.</p>
        </div>
      )}
    </div>
  );
}
