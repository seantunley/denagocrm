import { requireUser, isTenantOwner } from "@/lib/auth";
import HelpNav from "@/components/help/HelpNav";
import HelpHomeStrip from "@/components/help/HelpHomeStrip";
import { categoriesWithArticles } from "@/lib/help/content";
import { loadCustomGuides } from "@/lib/help/customGuidesStore";
import { WHATS_NEW, whatsNewFor } from "@/lib/help/whatsNew";
import { getEnabledModuleIds } from "@/lib/modules/enabled";

export default async function HelpLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  const [enabled, owner, ownGuides] = await Promise.all([getEnabledModuleIds(), isTenantOwner(), loadCustomGuides().catch(() => [])]);
  const builtIn = categoriesWithArticles(enabled).map((c) => ({
    key: c.key,
    label: c.label,
    articles: c.articles.map((a) => ({ slug: a.slug, title: a.title, summary: a.summary, keywords: a.keywords })),
  }));
  // The workspace's own guides lead the side menu and its search. Their "slug" is their path under /help, so the
  // menu links and highlights them like any other guide.
  const groups = ownGuides.length
    ? [{ key: "ours", label: "Our own guides", articles: ownGuides.map((g) => ({ slug: `ours/${g.id}`, title: g.title, summary: g.summary, keywords: [] as string[] })) }, ...builtIn]
    : builtIn;
  const latest = whatsNewFor(WHATS_NEW, { owner, modules: enabled })[0] ?? null;

  return (
    <div className="grid gap-8 lg:grid-cols-[288px_minmax(0,1fr)]">
      <aside className="hidden lg:sticky lg:top-6 lg:block lg:max-h-[calc(100dvh-3rem)] lg:self-start lg:overflow-y-auto lg:pr-1">
        <HelpNav groups={groups} />
      </aside>
      <div className="min-w-0">
        {/* On the help home only: what changed lately, and the workspace's own guides. */}
        <HelpHomeStrip latest={latest ? { title: latest.title, date: latest.date } : null} guideCount={ownGuides.length} canWrite={owner} />
        {children}
      </div>
    </div>
  );
}
