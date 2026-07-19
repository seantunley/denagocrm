import { requireUser } from "@/lib/auth";
import HelpNav from "@/components/help/HelpNav";
import { categoriesWithArticles } from "@/lib/help/content";

export default async function HelpLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  const groups = categoriesWithArticles().map((c) => ({
    key: c.key,
    label: c.label,
    articles: c.articles.map((a) => ({ slug: a.slug, title: a.title, summary: a.summary, keywords: a.keywords })),
  }));

  return (
    <div className="grid gap-8 lg:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="hidden lg:sticky lg:top-6 lg:block lg:max-h-[calc(100dvh-3rem)] lg:self-start lg:overflow-y-auto lg:pr-1">
        <HelpNav groups={groups} />
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
