import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { isTenantOwner } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import MarkWhatsNewSeen from "@/components/help/MarkWhatsNewSeen";
import { WHATS_NEW, longDate, whatsNewFor } from "@/lib/help/whatsNew";
import { getEnabledModuleIds } from "@/lib/modules/enabled";

export const metadata: Metadata = { title: "What's new · Help" };

/** What changed lately, newest first, grouped by day (lib/help/whatsNew.ts). Opening it clears the dot on the help icon. */
export default async function WhatsNewPage() {
  const [owner, modules] = await Promise.all([isTenantOwner(), getEnabledModuleIds()]);
  const entries = whatsNewFor(WHATS_NEW, { owner, modules });
  const days = [...new Set(entries.map((entry) => entry.date))];

  return (
    <div className="space-y-6">
      <Link href="/help" className="inline-flex min-h-9 items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Help
      </Link>
      <PageHeader title="What's new" description="Changes you would notice, newest first." />
      <MarkWhatsNewSeen ids={entries.map((entry) => entry.id)} />

      {entries.length === 0 && <p className="card text-sm text-muted-foreground">Nothing new to report yet.</p>}

      <ol className="space-y-6">
        {days.map((day) => (
          <li key={day} className="space-y-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{longDate(day)}</h2>
            {entries.filter((entry) => entry.date === day).map((entry) => (
              <article key={entry.id} className="card space-y-2">
                <h3 className="font-semibold text-foreground">{entry.title}</h3>
                <p className="text-sm leading-6 text-muted-foreground">{entry.text}</p>
                {entry.href && (
                  <Link href={entry.href} className="inline-flex min-h-9 items-center gap-1 text-sm font-medium text-primary hover:underline">
                    {entry.hrefLabel ?? "Take a look"} <ArrowRight className="size-3.5" aria-hidden />
                  </Link>
                )}
              </article>
            ))}
          </li>
        ))}
      </ol>
    </div>
  );
}
