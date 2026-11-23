import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Plus } from "lucide-react";
import { isTenantOwner } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { CATEGORY_LABEL } from "@/lib/help/categories";
import { MAX_GUIDES } from "@/lib/help/customGuides";
import { loadCustomGuides } from "@/lib/help/customGuidesStore";

export const metadata: Metadata = { title: "Our own guides · Help" };

/** The workspace's own guides: everyone reads them, the owner writes them (lib/help/customGuides.ts). */
export default async function OurGuidesPage() {
  const [owner, guides] = await Promise.all([isTenantOwner(), loadCustomGuides()]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/help" className="inline-flex min-h-9 items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Help
      </Link>
      <PageHeader title="Our own guides" description="How this workspace does things, written by its owner. They sit beside the built-in guides.">
        {owner && guides.length < MAX_GUIDES && (
          <Link href="/help/ours/new" className="btn-primary">
            <Plus className="size-4" aria-hidden /> New guide
          </Link>
        )}
      </PageHeader>

      {guides.length === 0 ? (
        <div className="card space-y-1 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">No guides of your own yet.</p>
          <p>{owner ? "Write the first one: how you handle trade-ins, your delivery checklist, who approves a discount." : "The workspace owner can add guides here."}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {guides.map((guide) => (
            <li key={guide.id}>
              <Link href={`/help/ours/${guide.id}`} className="card block transition-colors hover:border-primary/35">
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{CATEGORY_LABEL[guide.area] ?? guide.area}</span>
                <span className="mt-1 block font-semibold text-foreground">{guide.title}</span>
                {guide.summary && <span className="mt-0.5 block text-sm text-muted-foreground">{guide.summary}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
