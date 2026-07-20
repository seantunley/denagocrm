import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight, ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import ArticleBody from "@/components/help/ArticleBody";
import { getArticle, articlesInCategory, HELP_ARTICLES } from "@/lib/help/content";
import { isArticleEnabled } from "@/lib/help/modules";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { CATEGORY_LABEL } from "@/lib/help/categories";

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

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link href="/help" className="inline-flex items-center gap-1 hover:text-foreground lg:hidden">
          <ArrowLeft className="size-3.5" /> Help
        </Link>
        <span className="hidden lg:inline">{CATEGORY_LABEL[article.category] ?? article.category}</span>
        <span className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium ${aud.cls}`}>{aud.label}</span>
      </div>

      <PageHeader title={article.title} description={article.summary} />

      <article className="rounded-2xl border border-border bg-card p-6 sm:p-8">
        <ArticleBody body={article.body} />
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
  );
}
