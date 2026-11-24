import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Pencil } from "lucide-react";
import { isTenantOwner } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import ArticleBody from "@/components/help/ArticleBody";
import ConfirmDelete from "@/components/ConfirmDelete";
import { deleteHelpGuide } from "@/app/actions/helpGuides";
import { CATEGORY_LABEL } from "@/lib/help/categories";
import { guideBlocks, isGuideId } from "@/lib/help/customGuides";
import { loadCustomGuides } from "@/lib/help/customGuidesStore";

export const metadata: Metadata = { title: "Our guide · Help" };

export default async function OurGuidePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isGuideId(id)) notFound();
  const [owner, guides] = await Promise.all([isTenantOwner(), loadCustomGuides()]);
  const guide = guides.find((item) => item.id === id);
  if (!guide) notFound();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link href="/help/ours" className="inline-flex min-h-9 items-center gap-1 hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Our own guides
        </Link>
        <span className="ml-auto rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-medium text-emerald-200">Written for this workspace</span>
      </div>

      <PageHeader title={guide.title} description={guide.summary || undefined}>
        {owner && (
          <>
            <Link href={`/help/ours/${guide.id}/edit`} className="btn-secondary">
              <Pencil className="size-4" aria-hidden /> Edit
            </Link>
            <ConfirmDelete
              action={deleteHelpGuide.bind(null, guide.id)}
              title="Delete this guide?"
              description={`"${guide.title}" will be removed for everyone in the workspace. This can't be undone.`}
              triggerClass="btn-secondary text-red-300"
              success="Guide deleted"
            />
          </>
        )}
      </PageHeader>

      <article className="rounded-2xl border border-border bg-card p-6 sm:p-8">
        <ArticleBody body={guideBlocks(guide.body)} />
      </article>

      <p className="text-xs text-muted-foreground">
        {CATEGORY_LABEL[guide.area] ?? guide.area}
        {guide.updatedBy ? ` · last edited by ${guide.updatedBy}` : ""}
        {Date.parse(guide.updatedAt) > 0 ? ` on ${formatDate(new Date(guide.updatedAt))}` : ""}
      </p>
    </div>
  );
}
