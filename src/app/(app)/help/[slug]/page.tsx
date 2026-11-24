import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight, ArrowLeft, ArrowUpRight, Clock } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import ArticleBody from "@/components/help/ArticleBody";
import { getArticle, articlesInCategory, HELP_ARTICLES } from "@/lib/help/content";
import { isArticleEnabled } from "@/lib/help/modules";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { CATEGORY_LABEL } from "@/lib/help/categories";
import { destinationFor } from "@/lib/help/destinations";
import { readKey } from "@/lib/help/readStore";
import { requireUser } from "@/lib/auth";
import { HelpAreaTag } from "@/components/help/HelpAreaIcon";
import MarkHelpRead from "@/components/help/MarkHelpRead";
import HelpOutline from "@/components/help/HelpOutline";
import { MIN_OUTLINE, outlineOf, readingMinutes } from "@/lib/help/outline";

export function generateStaticParams() {
  return HELP_ARTICLES.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const article = getArticle(slug);
  return { title: article ? `${article.title} · Help` : "Help" };
}

const AUDIENCE: Record<string, { label: string; cls: string }> = {
  everyone: { label: "Everyone", cls: "bg-white/[0.06] text-muted-foreground" },
  managers: { label: "Managers", cls: "bg-sky-500/15 text-sky-300" },
  admins: { label: "Admins only", cls: "bg-amber-500/15 text-amber-300" },
};

export default async function HelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = getArticle(slug);
  if (!article) notFound();

  // Articles owned by a switched-off module are treated as not found.
  const enabled = await getEnabledModuleIds();
  if (!isArticleEnabled(article, enabled)) notFound();

  const siblings = articlesInCategory(article.category, enabled);
  const idx = siblings.findIndex((a) => a.slug === article.slug);
  const prev = idx > 0 ? siblings[idx - 1] : null;
  const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;
  const aud = AUDIENCE[article.audience] ?? AUDIENCE.everyone;
  const user = await requireUser();
  // "Take me there": the screen this guide is about, when it is about one (lib/help/destinations.ts).
  const destination = destinationFor(article.slug);
  // Fewer than two headings is no outline — and then no column is kept for one (review of #1214).
  const headings = outlineOf(article.body);
  const outline = headings.length >= MIN_OUTLINE ? headings : null;
  const minutes = readingMinutes(article.body);

  return (
    // The guide, with its outline beside it on a wide screen (the canvas board "Help centre — article").
    // A guide with no outline has the whole width to itself — no empty column is kept beside it.
    <div className={outline ? "grid gap-10 xl:grid-cols-[minmax(0,1fr)_14rem]" : undefined}>
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Link href="/help" className="inline-flex items-center gap-1 hover:text-foreground lg:hidden">
          <ArrowLeft className="size-3.5" /> Help
        </Link>
<HelpAreaTag area={article.category} label={CATEGORY_LABEL[article.category] ?? article.category} />
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${aud.cls}`}>{aud.label}</span>
        <span className="inline-flex items-center gap-1"><Clock className="size-3.5" aria-hidden /> {minutes} min read</span>
      </div>

      <PageHeader title={article.title} description={article.summary} />
      {/* Opening the guide ticks it on this person's guided paths. */}
      <MarkHelpRead storageKey={readKey(user.id)} slug={article.slug} />

      {destination && (
        <div className="flex flex-col gap-3 rounded-2xl border border-primary/20 bg-primary/[0.06] p-4 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-foreground">Follow along on the real screen</p>
            <p className="text-sm text-muted-foreground">Opens {destination.label} in a new tab, so this guide stays open beside it.</p>
          </div>
          <Link href={destination.href} target="_blank" className="btn-primary shrink-0 self-start sm:self-auto">
            Open {destination.label}
            <ArrowUpRight className="size-4" aria-hidden />
          </Link>
        </div>
      )}

      <article className="rounded-2xl border border-border bg-card p-6 sm:p-8">
        <ArticleBody body={article.body} anchors />
      </article>

      <div className="grid gap-3 sm:grid-cols-2">
        {prev ? (
          <Link href={`/help/${prev.slug}`} className="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/30">
            <ChevronLeft className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
            <span className="min-w-0">
              <span className="block text-[11px] uppercase tracking-wide text-muted-foreground/60">Previous</span>
              <span className="block truncate text-sm font-medium text-foreground">{prev.title}</span>
            </span>
          </Link>
        ) : <span />}
        {next && (
          <Link href={`/help/${next.slug}`} className="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 text-right transition-colors hover:border-primary/30 sm:col-start-2">
            <span className="ml-auto min-w-0">
              <span className="block text-[11px] uppercase tracking-wide text-muted-foreground/60">Next</span>
              <span className="block truncate text-sm font-medium text-foreground">{next.title}</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
          </Link>
        )}
      </div>
    </div>
      {outline && (
        <aside className="hidden xl:block">
          <div className="sticky top-6"><HelpOutline items={outline} /></div>
        </aside>
      )}
    </div>
  );
}
