import type { Metadata } from "next";
import Link from "next/link";
import {
  Compass, SquareKanban, FileText, Package, Wrench, Megaphone, MessageSquare, Bot, FolderOpen,
  ChartColumnIncreasing, Cog, ArrowRight, BookOpen, type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { categoriesWithArticles } from "@/lib/help/content";
import { getEnabledModuleIds } from "@/lib/modules/enabled";

export const metadata: Metadata = { title: "Help & user manual" };

const ICONS: Record<string, LucideIcon> = {
  Compass, SquareKanban, FileText, Package, Wrench, Megaphone, MessageSquare, Bot, FolderOpen, ChartColumnIncreasing, Cog,
};

export default async function HelpHomePage() {
  const enabled = await getEnabledModuleIds();
  const categories = categoriesWithArticles(enabled);
  const articleCount = categories.reduce((n, c) => n + c.articles.length, 0);

  return (
    <div className="space-y-8">
      <PageHeader title="Help &amp; user manual" description={`Step-by-step guides for every part of Denago CRM — ${articleCount} articles across ${categories.length} areas.`}>
        <Link href="/manual" target="_blank" className={buttonVariants({ variant: "outline", size: "sm" })}>
          <BookOpen className="size-4" /> Full manual (print / PDF)
        </Link>
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {categories.map((c) => {
          const Icon = ICONS[c.icon] ?? BookOpen;
          const first = c.articles[0];
          return (
            <Link
              key={c.key}
              href={first ? `/help/${first.slug}` : "/help"}
              className="group flex flex-col rounded-2xl border border-border bg-card p-5 transition-colors hover:border-primary/30"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Icon className="size-5" />
                </span>
                <div className="min-w-0">
                  <p className="font-semibold text-foreground">{c.label}</p>
                  <p className="text-xs text-muted-foreground">{c.articles.length} article{c.articles.length === 1 ? "" : "s"}</p>
                </div>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">{c.description}</p>
              <ul className="mt-4 space-y-1.5 border-t border-border/60 pt-3">
                {c.articles.slice(0, 4).map((a) => (
                  <li key={a.slug} className="flex items-center gap-2 text-[13px] text-muted-foreground/90">
                    <ArrowRight className="size-3 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-primary" />
                    <span className="truncate">{a.title}</span>
                  </li>
                ))}
                {c.articles.length > 4 && (
                  <li className="pl-5 text-[12px] text-muted-foreground/50">+{c.articles.length - 4} more</li>
                )}
              </ul>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
