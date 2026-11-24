import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { isTenantOwner, requireUser } from "@/lib/auth";
import { hasAnyPermission } from "@/lib/permissions";
import { categoriesWithArticles, getArticle } from "@/lib/help/content";
import { CATEGORY_LABEL } from "@/lib/help/categories";
import { HELP_AREA_STYLE } from "@/lib/help/areas";
import { featuredFor, pathsFor } from "@/lib/help/paths";
import { readKey } from "@/lib/help/readStore";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { HelpAreaTag, HelpAreaTile } from "@/components/help/HelpAreaIcon";
import HelpSearch from "@/components/help/HelpSearch";
import HelpPaths from "@/components/help/HelpPaths";
import HelpDoors from "@/components/help/HelpDoors";
import { loadCustomGuides } from "@/lib/help/customGuidesStore";
import { WHATS_NEW, whatsNewFor } from "@/lib/help/whatsNew";

export const metadata: Metadata = { title: "Help & user manual" };

/**
 * The help centre's front door (2026-11-23; the canvas board "Help centre —
 * home"): search first, then guided paths for the reader's kind of work, a few
 * guides worth starting with, and every area in its own colour.
 */
export default async function HelpHomePage() {
  const user = await requireUser();
  const enabled = await getEnabledModuleIds();
  const categories = categoriesWithArticles(enabled);
  const articles = categories.flatMap((category) => category.articles);
  const visible = new Set(articles.map((article) => article.slug));

  // Who is reading decides which paths are offered: everyone gets the everyday ones, a manager the team one, the owner all.
  // The WORKSPACE owner (Tenant.ownerUserId, via isTenantOwner) — not `user.role === "owner"`, which is the platform
  // owner only: a workspace's real owner is often role "member" (review of #1200).
  const admin = await isTenantOwner();
  const manager = admin || (await hasAnyPermission(user, "forecast.view", "pipelines.manage"));
  const paths = pathsFor(visible, { manager, admin }).map((path) => ({
    key: path.key,
    label: path.label,
    blurb: path.blurb,
    articles: path.slugs.flatMap((slug) => {
      const article = getArticle(slug);
      return article ? [{ slug, title: article.title }] : [];
    }),
  }));
  // Beside the path: what changed lately, and the workspace's own guides — which the big search finds too.
  const ownGuides = await loadCustomGuides().catch(() => []);
  const latest = whatsNewFor(WHATS_NEW, { owner: admin, modules: enabled })[0] ?? null;
  const searchable = [
    ...ownGuides.map((guide) => ({ slug: `ours/${guide.id}`, title: guide.title, summary: guide.summary, keywords: [] as string[], area: guide.area, areaLabel: "Our own guide" })),
    ...articles.map((article) => ({
      slug: article.slug,
      title: article.title,
      summary: article.summary,
      keywords: article.keywords,
      area: article.category,
      areaLabel: CATEGORY_LABEL[article.category] ?? article.category,
    })),
  ];
  const featured = featuredFor(visible).flatMap((slug) => {
    const article = getArticle(slug);
    return article ? [article] : [];
  });

  return (
    <div className="space-y-10">
      <header className="relative overflow-hidden rounded-3xl border border-border bg-sidebar px-5 py-12 text-center depth-card sm:px-8 sm:py-16">
        {/* Decoration: one soft glow behind the search. (Three coloured planes stood here and read as stray blocks.) */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-24 mx-auto h-64 max-w-2xl rounded-full bg-primary/[0.09] blur-3xl" />
        <div className="relative flex flex-col items-center gap-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">Help centre</p>
          {/* `!`: the workspace sets every page h1 to one compact size; this hero is the one heading meant to be large. */}
          <h1 className="!text-4xl font-semibold !leading-tight tracking-tight text-foreground sm:!text-5xl">How can we help?</h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            {articles.length} step-by-step guides across {categories.length} areas of the CRM.
          </p>
          <HelpSearch items={searchable} />
        </div>
      </header>

      <HelpPaths
        paths={paths}
        storageKey={readKey(user.id)}
        beside={<HelpDoors latest={latest ? { title: latest.title, text: latest.text } : null} guideCount={ownGuides.length} canWrite={admin} />}
      />

      {featured.length > 0 && (
        <section aria-labelledby="help-featured" className="space-y-3">
          <h2 id="help-featured" className="text-lg font-semibold text-foreground">Good places to start</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {featured.map((article) => (
              <Link
                key={article.slug}
                href={`/help/${article.slug}`}
                className={cn(
                  "group flex flex-col gap-2.5 rounded-2xl border border-border border-t-2 bg-card p-4 transition-[transform,border-color] depth-card hover:-translate-y-0.5",
                  HELP_AREA_STYLE[article.category].edge,
                )}
              >
                <span><HelpAreaTag area={article.category} label={CATEGORY_LABEL[article.category] ?? article.category} /></span>
                <span className="font-semibold leading-snug text-foreground">{article.title}</span>
                <span className="line-clamp-3 text-[13px] text-muted-foreground">{article.summary}</span>
                <span className="mt-auto inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-primary">
                  Read the guide <ArrowRight className="size-3" aria-hidden />
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="help-areas" className="space-y-3">
        <h2 id="help-areas" className="text-lg font-semibold text-foreground">Browse by area</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {categories.map((category) => {
            const first = category.articles[0];
            return (
              <Link
                key={category.key}
                href={first ? `/help/${first.slug}` : "/help"}
                className="group flex items-start gap-3.5 rounded-2xl border border-border bg-card p-4 transition-[transform,border-color] depth-card hover:-translate-y-0.5 hover:border-white/15"
              >
                <HelpAreaTile area={category.key} icon={category.icon} />
                <span className="min-w-0">
                  <span className="flex items-baseline gap-2">
                    <span className="font-semibold text-foreground">{category.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {category.articles.length} guide{category.articles.length === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[13px] text-muted-foreground">{category.description}</span>
                </span>
              </Link>
            );
          })}
          <Link
            href="/manual"
            target="_blank"
            className="flex items-center gap-3.5 rounded-2xl border border-dashed border-white/20 p-4 transition-colors hover:border-white/35"
          >
            <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground depth-inset">
              <BookOpen className="size-5" />
            </span>
            <span>
              <span className="block font-semibold text-foreground">Full manual</span>
              <span className="block text-[13px] text-muted-foreground">Everything in one place, to print or save as PDF.</span>
            </span>
          </Link>
        </div>
      </section>
    </div>
  );
}
